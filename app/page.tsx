'use client'

import React, { useEffect, useState, useRef } from 'react';
import { getEmbedding, EmbeddingIndex } from 'client-vector-search';
import { Tldraw, useEditor, Editor, Vec, createTLStore, TLStore, Box, exportAs, copyAs, exportToBlob } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'

interface ObjectItem {
  id: string;
  name: string;
  embedding: number[];
  shapeId: string;
}

interface WhiteboardWithSearchProps {
  onShapesChange: (shapes: Map<string, { text: string; center: Vec }>) => void;
}

const calculateDistance = (p1: Vec, p2: Vec): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

const CLUSTER_THRESHOLD = 200;

const WhiteboardWithSearch: React.FC<WhiteboardWithSearchProps> = ({ onShapesChange }) => {
  const editor = useEditor();
  const previousShapesRef = useRef<Map<string, { text: string; center: Vec }>>(new Map());

  useEffect(() => {
    if (!editor) return () => {};

    const handleChange = () => {
      const newTextShapes = new Map<string, { text: string; center: Vec }>();
      const shapes = editor.getCurrentPageShapes();
      
      const changedShapes = shapes.filter(shape => 
        'text' in shape.props && 
        editor.isShapeOfType(shape, 'text') &&
        shape.props.text?.trim()
      );
      
      let hasChanges = false;

      changedShapes.forEach((shape) => {
        const bounds = editor.getShapePageBounds(shape);
        if (bounds) {
          const newData = {
            text: shape.props.text || '',
            center: bounds.center
          };
          newTextShapes.set(shape.id, newData);

          // Check if this shape has changed
          const previousData = previousShapesRef.current.get(shape.id);
          if (!previousData || 
              previousData.text !== newData.text ||
              previousData.center.x !== newData.center.x ||
              previousData.center.y !== newData.center.y) {
            hasChanges = true;
          }
        }
      });

      // Check for deleted shapes
      if (previousShapesRef.current.size !== newTextShapes.size) {
        hasChanges = true;
      }
      
      if (hasChanges) {
        previousShapesRef.current = newTextShapes;
        onShapesChange(newTextShapes);
      }
    };

    const cleanup = editor.addListener('change', handleChange);
    
    return () => {
      editor.removeListener('change', handleChange);
    };
  }, [editor, onShapesChange]);

  return null;
};

const getEmbeddingWithRetry = async (text: string, retries = 3): Promise<number[]> => {
  try {
    return await getEmbedding(text);
  } catch (error) {
    if (retries > 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getEmbeddingWithRetry(text, retries - 1);
    }
    throw error;
  }
};

const PERSISTENCE_KEY = 'tldraw-whiteboard-state';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  isLoading?: boolean;
}

// Add this component near the top of the file, before the Home component
const LoadingSpinner: React.FC = () => (
  <div style={{
    display: 'inline-flex',
    marginLeft: '8px',
    verticalAlign: 'middle'
  }}>
    <style jsx>{`
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
      .spinner {
        width: 12px;
        height: 12px;
        border: 2px solid currentColor;
        border-right-color: transparent;
        border-radius: 50%;
        animation: spin 0.75s linear infinite;
      }
    `}</style>
    <div className="spinner" />
  </div>
);

export default function Home() {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<ObjectItem[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const embeddingIndexRef = useRef<EmbeddingIndex | null>(null);
  const [store] = useState(() => createTLStore());
  const [isLoading, setIsLoading] = useState(false);
  const [loadingState, setLoadingState] = useState<
    { status: 'loading' } | { status: 'ready' } | { status: 'error'; error: string }
  >({
    status: 'loading',
  });
  const [isChatMode, setIsChatMode] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [currentScreenshot, setCurrentScreenshot] = useState<string | null>(null);
  // Load persisted state
  useEffect(() => {
    try {
      const persistedState = localStorage.getItem(PERSISTENCE_KEY);
      if (persistedState) {
        const state = JSON.parse(persistedState);
        store.loadSnapshot(state);
      }
      setLoadingState({ status: 'ready' });
    } catch (error: any) {
      setLoadingState({ status: 'error', error: error.message });
    }
  }, [store]);

  // Save state on changes
  useEffect(() => {
    if (!editor) return;

    const handleChange = () => {
      try {
        const snapshot = editor.store.getSnapshot();
        localStorage.setItem(PERSISTENCE_KEY, JSON.stringify(snapshot));
        console.log('Saved whiteboard state to localStorage');
      } catch (error) {
        console.error('Failed to save whiteboard state:', error);
      }
    };

    const cleanup = editor.store.listen(handleChange);
    return () => {
      cleanup();
    };
  }, [editor]);

  // Initialize embedding index
  useEffect(() => {
    embeddingIndexRef.current = new EmbeddingIndex();
    embeddingIndexRef.current.getAllObjectsFromIndexedDB('indexedDB').catch(console.error);
  }, []);

  const updateVectorIndex = async (textShapes: Map<string, { text: string; center: Vec }>) => {
    if (!embeddingIndexRef.current || !editor) return;

    console.log('Starting index update...');

    // Get all existing objects to track what needs to be deleted
    const existingObjects = await embeddingIndexRef.current.getAllObjectsFromIndexedDB('indexedDB');
    const existingShapeIds = new Map(existingObjects.map(obj => [obj.shapeId, obj]));

    const shapes = Array.from(textShapes.entries()).map(([id, data]) => ({
      id,
      text: data.text,
      center: data.center
    }));

    // Create clusters as before
    const clusters = shapes.reduce((acc: { shapes: any[], center: Vec }[], shape) => {
      const existingCluster = acc.find(cluster => 
        calculateDistance(shape.center, cluster.center) < CLUSTER_THRESHOLD
      );

      if (existingCluster) {
        existingCluster.shapes.push(shape);
        existingCluster.center = {
          x: existingCluster.shapes.reduce((sum, s) => sum + s.center.x, 0) / existingCluster.shapes.length,
          y: existingCluster.shapes.reduce((sum, s) => sum + s.center.y, 0) / existingCluster.shapes.length
        };
      } else {
        acc.push({
          shapes: [shape],
          center: shape.center
        });
      }
      return acc;
    }, []);

    for (const cluster of clusters) {
      const combinedText = cluster.shapes
        .map(shape => shape.text.trim())
        .filter(Boolean)
        .join(' ');
      
      if (combinedText) {
        try {
          // Check if any shape in this cluster has an existing embedding
          const existingEmbeddings = cluster.shapes
            .map(shape => existingShapeIds.get(shape.id))
            .filter(Boolean);

          if (existingEmbeddings.length > 0) {
            console.log('Found existing embeddings for cluster:', {
              text: combinedText,
              count: existingEmbeddings.length
            });

            // Remove old embeddings
            for (const existing of existingEmbeddings) {
              await embeddingIndexRef.current.remove({ id: existing.id });
              console.log('Removed old embedding:', {
                id: existing.id,
                text: existing.name,
                shapeId: existing.shapeId
              });
            }
          }

          // Create new embedding without position
          const embedding = await getEmbeddingWithRetry(combinedText);
          const object: ObjectItem = {
            id: `cluster-${Date.now()}-${Math.random()}`,
            name: combinedText,
            embedding,
            shapeId: cluster.shapes[0].id
          };
          
          await embeddingIndexRef.current.add(object);
          console.log('Added/Updated embedding:', {
            text: combinedText,
            shapeId: object.shapeId
          });

        } catch (error) {
          console.error('Failed to process cluster:', error);
        }
      }
    }

    await embeddingIndexRef.current.saveIndex('indexedDB');
    console.log('Index update completed');
  };

  const handleSearch = async () => {
    if (!query.trim() || !editor || !embeddingIndexRef.current) return;

    try {
      console.log('Starting search for:', query);
      const queryEmbedding = await getEmbeddingWithRetry(query);
      
      const searchResults = await embeddingIndexRef.current.search(queryEmbedding);
      console.log('Raw search results:', searchResults);

      const typedResults = searchResults.map(result => result.object) as ObjectItem[];
      setResults(typedResults);
      
      if (typedResults.length > 0) {
        const topResult = typedResults[0];
        const shape = editor.getShape(topResult.shapeId);
        
        if (shape) {
          const bounds = editor.getShapePageBounds(shape);
          if (bounds) {
            editor.centerOnPoint(bounds.center);
            editor.select(shape.id);
            
            console.log('Centered on shape:', {
              text: topResult.name,
              shapeId: topResult.shapeId,
              currentPosition: bounds.center
            });
          }
        } else {
          console.log('Shape not found:', topResult.shapeId);
        }
      }
    } catch (error) {
      console.error('Error during search:', error);
      setResults([]);
    }
  };

  const handleDeleteIndex = () => {
    if (embeddingIndexRef.current) {
      embeddingIndexRef.current.deleteIndexedDB();
      console.log('Index deleted');
    }
  };

  // Add a function to handle result click
  const handleResultClick = (item: ObjectItem) => {
    if (!editor) return;

    const shape = editor.getShape(item.shapeId);
    if (shape) {
      const bounds = editor.getShapePageBounds(shape);
      if (bounds) {
        editor.centerOnPoint(bounds.center);
        editor.select(shape.id);
        
        console.log('Navigated to shape:', {
          text: item.name,
          shapeId: item.shapeId,
          currentPosition: bounds.center
        });
      }
    } else {
      console.log('Shape not found:', item.shapeId);
    }
  };

  // Add this constant for screenshot dimensions
  const SCREENSHOT_SIZE = {
    width: 2560,
    height: 1440
  };

  // Update the captureAreaAroundShapes function
  const captureAreaAroundShapes = async (shapes: { position: Vec }[]) => {
    if (!editor || shapes.length === 0) return null;

    try {
      // Calculate the median position
      const positions = shapes.map(s => s.position);
      const sortedX = [...positions].sort((a, b) => a.x - b.x);
      const sortedY = [...positions].sort((a, b) => a.y - b.y);
      
      const medianX = sortedX[Math.floor(positions.length / 2)].x;
      const medianY = sortedY[Math.floor(positions.length / 2)].y;

      // Create a fixed-size box centered on the median position
      const box = new Box(
        medianX - SCREENSHOT_SIZE.width / 2,
        medianY - SCREENSHOT_SIZE.height / 2,
        SCREENSHOT_SIZE.width,
        SCREENSHOT_SIZE.height
      );

      // Get all shapes within the box
      const shapesInBox = editor.getCurrentPageShapes().filter((s) => {
        const pageBounds = editor.getShapeMaskedPageBounds(s);
        if (!pageBounds) return false;
        return box.includes(pageBounds);
      });

      if (shapesInBox.length === 0) return null;

      // Export the shapes as PNG
      const blob = await exportToBlob({
        editor,
        ids: shapesInBox.map(s => s.id),
        format: 'png',
        opts: {
          bounds: box,
          background: editor.getInstanceState().exportBackground
        }
      });

      // Convert blob to base64
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

    } catch (error) {
      console.error('Failed to capture area:', error);
      return null;
    }
  };

  // Update the generateChatResponse function
  const generateChatResponse = async (
    messages: ChatMessage[], 
    searchContext: string,
    base64Image: string | null
  ) => {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages,
          searchContext,
          base64Image
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Failed to generate response');
      }

      const data = await response.json();
      return data.content;

    } catch (error) {
      console.error('Error generating chat response:', error);
      throw error;
    }
  };

  // Update the handleChat function
  const handleChat = async () => {
    if (!chatInput.trim() || !editor || !embeddingIndexRef.current) return;
    
    const userInputText = chatInput;
    setChatInput(''); // Clear input immediately
    
    // Add user message with loading state
    setMessages(prev => [...prev, {
      role: 'user',
      content: userInputText,
      isLoading: true
    }]);
    
    setIsLoading(true);

    try {
      // First, perform the search
      const queryEmbedding = await getEmbeddingWithRetry(userInputText);
      const searchResults = await embeddingIndexRef.current.search(queryEmbedding, {
        topK: 100,
        useStorage: 'indexedDB'
      });

      // Collect detailed search context
      const searchContext = searchResults
        .map(result => {
          const shape = editor.getShape(result.object.shapeId);
          const text = shape && 'text' in shape.props ? shape.props.text : '';
          return `
${text}`;
        })
        .join('\n\n');

      console.log('Search context:', searchContext);

      // Find relevant shapes and capture screenshot
      const relevantShapes = searchResults
        .map(result => {
          const shape = editor.getShape(result.object.shapeId);
          if (!shape) return null;
          const bounds = editor.getShapePageBounds(shape);
          if (!bounds) return null;
          return {
            shape,
            position: bounds.center,
            similarity: result.similarity
          };
        })
        .filter(Boolean);

      // Capture screenshot if there are relevant shapes
      let screenshot: string | null = null;
      if (relevantShapes.length > 0) {
        screenshot = await captureAreaAroundShapes(relevantShapes);
        setCurrentScreenshot(screenshot);

        // Center view on the median position
        const medianX = relevantShapes.sort((a, b) => a.position.x - b.position.x)[
          Math.floor(relevantShapes.length / 2)
        ].position.x;
        const medianY = relevantShapes.sort((a, b) => a.position.y - b.position.y)[
          Math.floor(relevantShapes.length / 2)
        ].position.y;

        editor.centerOnPoint(new Vec(medianX, medianY));
      } else {
        setCurrentScreenshot(null);
      }

      // Get AI response with search context and screenshot
      const aiResponse = await generateChatResponse(
        [...messages, {
          role: 'user',
          content: userInputText,
          isLoading: true
        }],
        searchContext,
        await captureAreaAroundShapes(relevantShapes)
      );

      // Update user message to remove loading state
      setMessages(prev => prev.map((msg, idx) => 
        idx === prev.length - 1 ? { ...msg, isLoading: false } : msg
      ));

      // Add assistant message
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: aiResponse
      }]);

    } catch (error) {
      console.error('Error during chat:', error);
      // Update user message to remove loading state and add error message
      setMessages(prev => [
        ...prev.slice(0, -1),
        { ...prev[prev.length - 1], isLoading: false },
        {
          role: 'assistant',
          content: 'Sorry, there was an error processing your message.'
        }
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.mainContent}>
        <div style={styles.searchContainer}>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search within whiteboard..."
            style={styles.input}
          />
          <button type="submit" style={styles.button} onClick={handleSearch}>Search</button>
          {/* <button 
            type="button"
            onClick={handleDeleteIndex} 
            style={styles.deleteButton}
          >
            Clear Index
          </button> */}
        </div>
        {results.length > 0 && (
          <div style={styles.resultsContainer}>
            <h3 style={styles.resultsTitle}>Results:</h3>
            <ul style={styles.resultsList}>
              {results.map((item) => (
                <li 
                  key={item.id} 
                  style={styles.resultItem}
                  onClick={() => handleResultClick(item)}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = '#f0f0f0';
                    e.currentTarget.style.cursor = 'pointer';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = '#ffffff';
                  }}
                >
                  {item.name}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div style={styles.whiteboard}>
          {loadingState.status === 'error' ? (
            <div style={styles.errorMessage}>
              Error loading whiteboard: {loadingState.error}
            </div>
          ) : (
            <Tldraw
              store={store}
              onMount={setEditor}
              autoFocus
            >
              <WhiteboardWithSearch onShapesChange={updateVectorIndex} />
            </Tldraw>
          )}
        </div>
      </div>

      <div style={styles.chatSidebar}>
        <div style={styles.chatHeader}>
          <h3 style={styles.chatTitle}>Chat</h3>
        </div>
        <div style={styles.messagesContainer}>
          {messages.map((message, index) => (
            <div 
              key={index} 
              style={message.role === 'user' ? styles.userMessage : styles.assistantMessage}
            >
              <div style={styles.messageContent}>
                {message.content}
                {message.isLoading && <LoadingSpinner />}
              </div>
            </div>
          ))}
          {currentScreenshot && (
            <div style={styles.screenshotContainer}>
              <img 
                src={currentScreenshot} 
                alt="Current context"
                style={styles.screenshot}
                onClick={() => {
                  window.open(currentScreenshot, '_blank');
                }}
              />
            </div>
          )}
        </div>
        <form 
          style={styles.chatInputContainer}
          onSubmit={(e) => {
            e.preventDefault();
            if (!isLoading) {
              handleChat();
            }
          }}
        >
          <input
            type="text"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder={isLoading ? "Processing..." : "Ask about your whiteboard..."}
            style={styles.chatInput}
            disabled={isLoading}
          />
          <button 
            type="submit" 
            style={{
              ...styles.chatButton,
              opacity: isLoading ? 0.7 : 1,
              cursor: isLoading ? 'not-allowed' : 'pointer'
            }}
            disabled={isLoading}
          >
            Send
          </button>
        </form>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    height: '100vh',
    display: 'flex',
    gap: '10px',
    padding: '10px',
    backgroundColor: '#ffffff',
  },
  mainContent: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    minWidth: 0, // Prevent flex item from overflowing
  },
  chatSidebar: {
    width: '300px',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
    boxShadow: '-2px 0 5px rgba(0,0,0,0.1)',
  },
  chatHeader: {
    padding: '15px',
    borderBottom: '1px solid #ddd',
  },
  chatTitle: {
    margin: 0,
    color: '#333',
    fontSize: '16px',
    fontWeight: '500',
  },
  messagesContainer: {
    flex: 1,
    overflowY: 'auto',
    padding: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  userMessage: {
    alignSelf: 'flex-end',
    backgroundColor: '#0066cc',
    color: '#ffffff',
    padding: '8px 12px',
    borderRadius: '12px 12px 0 12px',
    maxWidth: '85%',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  assistantMessage: {
    alignSelf: 'flex-start',
    backgroundColor: '#ffffff',
    color: '#000000',
    padding: '8px 12px',
    borderRadius: '12px 12px 12px 0',
    maxWidth: '85%',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  messageContent: {
    marginBottom: '8px',
    wordBreak: 'break-word',
    color: 'inherit',
    fontSize: '14px',
    lineHeight: '1.4',
  },
  screenshotContainer: {
    position: 'relative',
    width: '100%',
    borderRadius: '4px',
    overflow: 'hidden',
    cursor: 'pointer',
  },
  screenshot: {
    width: '100%',
    height: 'auto',
    display: 'block',
    transition: 'transform 0.2s ease',
    '&:hover': {
      transform: 'scale(1.02)',
    },
  },
  chatInputContainer: {
    padding: '10px',
    borderTop: '1px solid #ddd',
    display: 'flex',
    gap: '8px',
  },
  chatInput: {
    padding: '8px 12px',
    fontSize: '16px',
    flex: 1,
    borderRadius: '4px',
    border: '1px solid #ddd',
    backgroundColor: '#ffffff',
    color: '#000000',
    '::placeholder': {
      color: '#666666',
    },
  },
  chatButton: {
    padding: '8px 16px',
    fontSize: '14px',
    cursor: 'pointer',
    backgroundColor: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '20px',
    fontWeight: '500',
    '&:hover': {
      backgroundColor: '#0052a3',
    },
  },
  searchContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
  },
  input: {
    padding: '8px 12px',
    fontSize: '16px',
    flex: 1,
    borderRadius: '4px',
    border: '1px solid #ddd',
    backgroundColor: '#ffffff',
    color: '#000000',
    '::placeholder': {
      color: '#666666',
    },
  },
  button: {
    padding: '8px 16px',
    fontSize: '14px',
    cursor: 'pointer',
    backgroundColor: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    fontWeight: '500',
  },
  deleteButton: {
    padding: '8px 16px',
    fontSize: '14px',
    backgroundColor: '#ff4d4d',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: '500',
  },
  resultsContainer: {
    padding: '15px',
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    maxHeight: '150px',
    overflowY: 'auto',
    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
    border: '1px solid #e0e0e0',
  },
  resultsList: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
  },
  resultItem: {
    padding: '8px 12px',
    borderBottom: '1px solid #e0e0e0',
    color: '#000000',
    fontSize: '14px',
    lineHeight: '1.4',
    backgroundColor: '#ffffff',
    transition: 'background-color 0.2s ease',
    userSelect: 'none', // Prevent text selection on click
    '&:last-child': {
      borderBottom: 'none',
    },
    '&:hover': {
      backgroundColor: '#f8f8f8',
    },
  },
  resultsTitle: {
    margin: '0 0 10px 0',
    color: '#333333',
    fontSize: '16px',
    fontWeight: '500',
  },
  whiteboard: {
    flex: 1,
    borderRadius: '8px',
    overflow: 'hidden',
    border: '1px solid #ddd',
    backgroundColor: '#ffffff',
  },
  errorMessage: {
    padding: '20px',
    color: '#ff4d4d',
    textAlign: 'center',
    backgroundColor: '#fff',
    border: '1px solid #ff4d4d',
    borderRadius: '8px',
    margin: '20px',
  },
  settingsButton: {
    padding: '8px 16px',
    fontSize: '14px',
    backgroundColor: '#666666',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: '500',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },

  settingsPane: {
    position: 'absolute',
    top: '60px',
    right: '320px', // Adjusted to not overlap with chat sidebar
    width: '300px',
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    padding: '16px',
    zIndex: 1000,
  },

  settingsTitle: {
    margin: '0 0 16px 0',
    color: '#333333',
    fontSize: '16px',
    fontWeight: '500',
  },

  settingGroup: {
    marginBottom: '16px',
  },

  settingLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    color: '#333333',
    fontSize: '14px',
  },

  settingInput: {
    padding: '8px 12px',
    fontSize: '14px',
    borderRadius: '4px',
    border: '1px solid #ddd',
    backgroundColor: '#ffffff',
    color: '#000000',
    width: '100%',
    marginTop: '4px',
  },

  settingHelp: {
    fontSize: '12px',
    color: '#666666',
    marginTop: '4px',
  },

  loadingSpinner: {
    display: 'inline-flex',
    marginLeft: '8px',
    verticalAlign: 'middle'
  },
  
  spinner: {
    width: '12px',
    height: '12px',
    border: '2px solid currentColor',
    borderRightColor: 'transparent',
    borderRadius: '50%',
    animation: 'spin 0.75s linear infinite',
  },

  '@keyframes spin': {
    from: {
      transform: 'rotate(0deg)'
    },
    to: {
      transform: 'rotate(360deg)'
    }
  }
};

const globalStyles = `
  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }
`;
