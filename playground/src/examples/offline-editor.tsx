import React, { useEffect, useState } from 'react';
import * as Y from 'yjs';
import { websocket } from 'teleportal/providers';

export function OfflineEditor() {
  const [provider, setProvider] = useState<websocket.Provider | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [localSynced, setLocalSynced] = useState(false);
  const [backgroundSynced, setBackgroundSynced] = useState(false);
  const [content, setContent] = useState('');

  useEffect(() => {
    // Listen for online/offline changes
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  useEffect(() => {
    async function initProvider() {
      try {
        const newProvider = await websocket.Provider.create({
          url: 'ws://localhost:1234',
          document: 'offline-demo',
          enableLocalPersistence: true,
          offlineSupport: true,
          localPersistencePrefix: 'offline-demo-'
        });

        // Set up event listeners
        newProvider.on('local-synced', () => {
          console.log('Document loaded from local storage');
          setLocalSynced(true);
        });

        newProvider.on('background-synced', () => {
          console.log('Background sync completed');
          setBackgroundSynced(true);
        });

        // Set up document content sync
        const yText = newProvider.doc.getText('content');
        
        // Initial content
        setContent(yText.toString());
        
        // Listen for changes
        yText.observe(() => {
          setContent(yText.toString());
        });

        setProvider(newProvider);
        
        // Provider should be immediately ready even if offline
        await newProvider.synced;
        console.log('Provider is ready!');
        
      } catch (error) {
        console.error('Failed to initialize provider:', error);
      }
    }

    initProvider();

    return () => {
      if (provider) {
        provider.destroy();
      }
    };
  }, []);

  const handleContentChange = (newContent: string) => {
    if (provider) {
      const yText = provider.doc.getText('content');
      
      // Replace the entire content (for simplicity)
      // In a real app, you'd want to apply delta changes
      yText.delete(0, yText.length);
      yText.insert(0, newContent);
    }
  };

  return (
    <div style={{ padding: '20px', maxWidth: '800px' }}>
      <h1>Offline Editor Demo</h1>
      
      <div style={{ marginBottom: '20px' }}>
        <div style={{ 
          display: 'flex', 
          gap: '20px', 
          marginBottom: '10px',
          alignItems: 'center'
        }}>
          <span style={{ 
            padding: '4px 8px', 
            borderRadius: '4px',
            backgroundColor: isOnline ? '#d4edda' : '#f8d7da',
            color: isOnline ? '#155724' : '#721c24',
            border: `1px solid ${isOnline ? '#c3e6cb' : '#f5c6cb'}`
          }}>
            {isOnline ? '🟢 Online' : '🔴 Offline'}
          </span>
          
          <span style={{ 
            padding: '4px 8px', 
            borderRadius: '4px',
            backgroundColor: localSynced ? '#d4edda' : '#fff3cd',
            color: localSynced ? '#155724' : '#856404',
            border: `1px solid ${localSynced ? '#c3e6cb' : '#ffeeba'}`
          }}>
            {localSynced ? '💾 Local Synced' : '⏳ Loading...'}
          </span>
          
          <span style={{ 
            padding: '4px 8px', 
            borderRadius: '4px',
            backgroundColor: backgroundSynced ? '#d4edda' : '#fff3cd',
            color: backgroundSynced ? '#155724' : '#856404',
            border: `1px solid ${backgroundSynced ? '#c3e6cb' : '#ffeeba'}`
          }}>
            {backgroundSynced ? '☁️ Server Synced' : '⏳ Syncing...'}
          </span>
        </div>
        
        <p style={{ margin: 0, fontSize: '14px', color: '#666' }}>
          Try going offline (disconnect internet) and continue editing. Your changes will be saved locally and sync when you come back online!
        </p>
      </div>

      <textarea
        value={content}
        onChange={(e) => handleContentChange(e.target.value)}
        placeholder="Start typing... Your content will be saved locally and synced in real-time when online."
        style={{
          width: '100%',
          height: '300px',
          padding: '10px',
          border: '1px solid #ddd',
          borderRadius: '4px',
          fontSize: '14px',
          fontFamily: 'monospace',
          resize: 'vertical'
        }}
      />
      
      <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
        <p><strong>How it works:</strong></p>
        <ul style={{ paddingLeft: '20px' }}>
          <li>Content is automatically saved to IndexedDB in your browser</li>
          <li>When offline, you can continue editing without any network connection</li>
          <li>When online, changes sync in real-time with other users</li>
          <li>Local changes are preserved and merged when connection is restored</li>
        </ul>
      </div>
    </div>
  );
}