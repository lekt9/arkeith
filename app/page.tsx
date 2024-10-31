'use client'

import React, { useEffect, useState, useRef } from 'react';
import { getEmbedding, EmbeddingIndex } from 'client-vector-search';
import { Tldraw, useEditor, Editor, Vec } from '@tldraw/tldraw'
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

export default function Home() {
  const [query, setQuery] = useState<string>('');
  const [results, setResults] = useState<ObjectItem[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const embeddingIndexRef = useRef<EmbeddingIndex | null>(null);

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
        const shape = editor.getShape(topResult["shapeId"]);
        
        if (shape) {
          // Get current bounds of the shape
          const bounds = editor.getShapePageBounds(shape);
          if (bounds) {
            // Center on the current position of the shape
            editor.centerOnPoint(bounds.center);
            editor.select(shape.id);
            editor.zoomToSelection();
            
            console.log('Centered on shape:', {
              text: topResult.name,
              shapeId: topResult["shapeId"],
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
        <button onClick={handleSearch} style={styles.button}>Search</button>
        <button onClick={handleDeleteIndex} style={styles.deleteButton}>Clear Index</button>
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
        <Tldraw onMount={setEditor}>
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
