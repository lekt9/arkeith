'use client'

import React, { useEffect, useState, useRef } from 'react';
import { getEmbedding, EmbeddingIndex } from 'client-vector-search';
import { Tldraw, useEditor, Editor, Vec } from '@tldraw/tldraw'
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

const calculateDistance = (p1: Vec, p2: Vec): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

const CLUSTER_THRESHOLD = 200;

const WhiteboardWithSearch: React.FC<WhiteboardWithSearchProps> = ({ onShapesChange }) => {
  const editor = useEditor();

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
      
      changedShapes.forEach((shape) => {
        const bounds = editor.getShapePageBounds(shape);
        if (bounds) {
          newTextShapes.set(shape.id, {
            text: shape.props.text || '',
            center: bounds.center
          });
        }
      });
      
      if (newTextShapes.size > 0) {
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
    if (!embeddingIndexRef.current) return;

    const shapes = Array.from(textShapes.entries()).map(([id, data]) => ({
      id,
      text: data.text,
      center: data.center
    }));

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
          const embedding = await getEmbeddingWithRetry(combinedText);
          const object: ObjectItem = {
            id: `cluster-${Date.now()}-${Math.random()}`,
            name: combinedText,
            embedding,
            shapeId: cluster.shapes[0].id,
            position: cluster.center
          };
          
          await embeddingIndexRef.current.add(object);
          console.log('Added to index:', object);
        } catch (error) {
          console.error('Failed to process cluster:', error);
        }
      }
    }

    await embeddingIndexRef.current.saveIndex('indexedDB');
  };

  const handleSearch = async () => {
    if (!query.trim() || !editor || !embeddingIndexRef.current) {
      console.log('Search prerequisites not met:', { 
        query: !!query.trim(), 
        editor: !!editor, 
        embeddingIndex: !!embeddingIndexRef.current 
      });
      return;
    }

    try {
      console.log('Starting search for:', query);
      const queryEmbedding = await getEmbeddingWithRetry(query);
      console.log('Got embedding:', queryEmbedding);

      const searchResults = await embeddingIndexRef.current.search(queryEmbedding);
      console.log('Raw search results:', searchResults);

      const typedResults = searchResults.map(result => result.object) as ObjectItem[];
      setResults(typedResults);
      
      console.log('Processed Search Results:', typedResults.map(result => ({
        text: result.name,
        position: result.position,
        shapeId: result.shapeId
      })));

      if (typedResults.length > 0) {
        const topResult = typedResults[0];
        if (topResult.position) {
          const targetPosition = new Vec(
            topResult.position.x,
            topResult.position.y,
            topResult.position.z || 0
          );
          
          editor.centerOnPoint(targetPosition);
          if (topResult.shapeId) {
            const shape = editor.getShapeById(topResult.shapeId);
            if (shape) {
              editor.select(topResult.shapeId);
              editor.zoomToSelection();
            }
          }
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
