'use client'

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { getEmbedding, EmbeddingIndex } from 'client-vector-search';
import { Tldraw, useEditor, Editor, TLShape, Vec } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'

interface ObjectItem {
  id: string;
  name: string;
  embedding: number[];
  shapeId?: string;
  position?: { x: number; y: number };
}

interface WhiteboardWithSearchProps {
  onShapesChange: (shapes: Map<string, { text: string; center: Vec }>) => void;
}

// Add this helper function at the top level
const calculateDistance = (p1: Vec, p2: Vec): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

const CLUSTER_THRESHOLD = 200; // Adjust this value based on your needs

interface Cluster {
  shapes: { id: string; text: string; center: Vec }[];
  center: Vec;
}

interface IndexingQueue {
  items: Map<string, { text: string; center: Vec }>[];
  processing: boolean;
}

const createQueue = (): IndexingQueue => ({
  items: [],
  processing: false,
});

const WhiteboardWithSearch: React.FC<WhiteboardWithSearchProps> = ({ onShapesChange }) => {
  const editor = useEditor()

  useEffect(() => {
    if (!editor) {
      console.log('Editor not initialized in WhiteboardWithSearch');
      return;
    }

    const handleChange = () => {
      console.log('Change detected in whiteboard');
      const newTextShapes = new Map<string, { text: string; center: Vec }>();
      const shapes = editor.getCurrentPageShapes();
      
      const changedShapes = shapes.filter(shape => 
        'text' in shape.props && editor.isShapeOfType(shape, 'text')
      );
      
      console.log('Found text shapes:', changedShapes.length);
      
      changedShapes.forEach((shape) => {
        const bounds = editor.getShapePageBounds(shape);
        if (bounds) {
          console.log('Processing shape:', { id: shape.id, text: shape.props.text, center: bounds.center });
          newTextShapes.set(shape.id, {
            text: shape.props.text || '',
            center: bounds.center
          });
        }
      });
      
      console.log('Sending shapes to vector index:', newTextShapes.size);
      onShapesChange(newTextShapes);
    };

    const unsubscribe = editor.addListener('change', handleChange);
    return () => {
      console.log('Cleaning up WhiteboardWithSearch listeners');
      editor.removeListener('change', handleChange);
    };
  }, [editor, onShapesChange]);

  return null;
};

const embeddingIndex = new EmbeddingIndex();

// Replace the direct import with a dynamic import
const getEmbeddingWithRetry = async (text: string, retries = 3): Promise<number[]> => {
  try {
    // Dynamically import the embedding function
    const { getEmbedding } = await import('client-vector-search');
    return await getEmbedding(text);
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying embedding generation. Attempts remaining: ${retries - 1}`);
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second before retry
      return getEmbeddingWithRetry(text, retries - 1);
    }
    console.error('Failed to generate embedding after all retries:', error);
    throw error;
  }
};

export default function Home() {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<ObjectItem[]>([]);
  const [initialObjects, setInitialObjects] = useState<ObjectItem[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const indexingQueue = useRef<IndexingQueue>(createQueue());

  const updateVectorIndex = useCallback(async (textShapes: Map<string, { text: string; center: Vec }>) => {
    console.log('Received shapes for indexing:', textShapes.size);
    indexingQueue.current.items.push(textShapes);
    
    if (indexingQueue.current.processing) {
      console.log('Queue is already processing, added to queue');
      return;
    }

    async function processQueue() {
      console.log('Starting queue processing');
      indexingQueue.current.processing = true;

      while (indexingQueue.current.items.length > 0) {
        const currentShapes = indexingQueue.current.items.shift();
        if (!currentShapes) continue;

        console.log('Processing batch of shapes:', currentShapes.size);
        const shapes = Array.from(currentShapes.entries()).map(([id, data]) => ({
          id,
          text: data.text,
          center: data.center
        }));

        const clusters: Cluster[] = [];
        
        for (const shape of shapes) {
          let addedToCluster = false;
          
          for (const cluster of clusters) {
            const distance = calculateDistance(shape.center, cluster.center);
            if (distance < CLUSTER_THRESHOLD) {
              console.log('Adding shape to existing cluster:', { shapeId: shape.id, distance });
              cluster.shapes.push(shape);
              cluster.center = {
                x: cluster.shapes.reduce((sum, s) => sum + s.center.x, 0) / cluster.shapes.length,
                y: cluster.shapes.reduce((sum, s) => sum + s.center.y, 0) / cluster.shapes.length
              };
              addedToCluster = true;
              break;
            }
          }
          
          if (!addedToCluster) {
            console.log('Creating new cluster for shape:', shape.id);
            clusters.push({
              shapes: [shape],
              center: shape.center
            });
          }
        }

        console.log('Created clusters:', clusters.length);
        const BATCH_SIZE = 5;
        for (let i = 0; i < clusters.length; i += BATCH_SIZE) {
          const batchClusters = clusters.slice(i, i + BATCH_SIZE);
          console.log(`Processing cluster batch ${i / BATCH_SIZE + 1}/${Math.ceil(clusters.length / BATCH_SIZE)}`);
          
          await Promise.all(batchClusters.map(async (cluster) => {
            const combinedText = cluster.shapes
              .map(shape => shape.text.trim())
              .filter(text => text.length > 0)
              .join(' ');
            
            if (combinedText) {
              try {
                console.log('Getting embedding for text:', combinedText.substring(0, 50) + '...');
                const embedding = await getEmbeddingWithRetry(combinedText);
                const object: ObjectItem = {
                  id: `cluster-${Date.now()}-${Math.random()}`,
                  name: combinedText,
                  embedding,
                  shapeId: cluster.shapes[0].id,
                  position: cluster.center
                };
                
                console.log('Adding object to index:', { id: object.id, shapeId: object.shapeId });
                await embeddingIndex.add(object);
              } catch (error) {
                console.error('Failed to process cluster:', error);
              }
            }
          }));
        }

        if (clusters.length > 0) {
          console.log('Saving index to IndexedDB');
          await embeddingIndex.saveIndex('indexedDB');
        }
      }

      console.log('Finished processing queue');
      indexingQueue.current.processing = false;
    }

    processQueue().catch(error => {
      console.error('Error processing queue:', error);
      indexingQueue.current.processing = false;
    });
  }, []);

  const handleSearch = async () => {
    try {
      console.log('Starting search with query:', query);
      if (!query.trim() || !editor) {
        console.log('Search query is empty or editor not initialized');
        return;
      }

      console.log('Getting embedding for search query');
      const queryEmbedding = await getEmbeddingWithRetry(query);
      if (!queryEmbedding) {
        console.error('Failed to generate embedding for search query');
        return;
      }

      console.log('Searching index');
      const searchResults = await embeddingIndex.search(queryEmbedding, { 
        topK: 5, 
        useStorage: 'indexedDB' 
      });

      const typedResults = searchResults as unknown as ObjectItem[];
      console.log('Search results:', typedResults);
      setResults(typedResults);

      if (typedResults.length > 0) {
        const topResult = typedResults[0];
        
        // If we have the position stored in the result, use that
        if (topResult.position) {
          console.log('Panning to stored position:', topResult.position);
          editor.centerOnPoint(Vec.From(topResult.position));
          
          // If we also have the shape ID, select it
          if (topResult.shapeId) {
            const shape = editor.getShape(topResult.shapeId);
            if (shape) {
              editor.select(shape.id);
              editor.zoomToSelection();
            }
          }
        } 
        // Fallback to shape-based positioning if position is not available
        else if (topResult.shapeId) {
          console.log('Falling back to shape-based positioning');
          const shape = editor.getShape(topResult.shapeId);
          if (shape) {
            editor.select(shape.id);
            editor.zoomToSelection();
            
            const pageBounds = editor.getShapePageBounds(shape);
            if (pageBounds) {
              editor.centerOnPoint(Vec.From(pageBounds.center));
            }
          }
        }
      }
    } catch (error) {
      console.error('Error during search:', error);
      setResults([]);
    }
  };

  const handleDeleteIndex = async () => {
    console.log('Deleting index from IndexedDB');
    await embeddingIndex.deleteIndexedDB('indexedDB');
    setResults([]);
    console.log('Index deleted successfully');
  };

  return (
    <div style={styles.container}>
      <div style={styles.searchContainer}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search within whiteboard..."
          style={styles.input}
        />
        <button onClick={handleSearch} style={styles.button}>
          Search
        </button>
        <button onClick={handleDeleteIndex} style={styles.deleteButton}>
          Clear Index
        </button>
      </div>
      {results.length > 0 && (
        <div style={styles.resultsContainer}>
          <h3>Results:</h3>
          <ul>
            {results.map((item) => (
              <li key={item.id}>{item.name}</li>
            ))}
          </ul>
        </div>
      )}
      <div style={styles.whiteboard}>
        <Tldraw
          onMount={(editor) => {
            setEditor(editor);
          }}
        >
          <WhiteboardWithSearch onShapesChange={updateVectorIndex} />
        </Tldraw>
      </div>
    </div>
  );
}

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    height: '100vh',
    display: 'flex',
    flexDirection: 'column',
    padding: '10px',
    gap: '10px',
  },
  searchContainer: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
  },
  input: {
    padding: '8px 12px',
    fontSize: '14px',
    flex: 1,
    borderRadius: '4px',
    border: '1px solid #ddd',
  },
  button: {
    padding: '8px 16px',
    fontSize: '14px',
    cursor: 'pointer',
    backgroundColor: '#0066cc',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
  },
  deleteButton: {
    padding: '8px 16px',
    fontSize: '14px',
    backgroundColor: '#ff4d4d',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  resultsContainer: {
    padding: '10px',
    backgroundColor: '#f5f5f5',
    borderRadius: '8px',
    maxHeight: '150px',
    overflowY: 'auto',
  },
  whiteboard: {
    flex: 1,
    borderRadius: '8px',
    overflow: 'hidden',
    border: '1px solid #ddd',
  },
};
