declare module 'y-indexeddb' {
  import { ObservableV2 } from 'lib0/observable';
  import * as Y from 'yjs';

  export class IndexeddbPersistence extends ObservableV2<{
    synced: (idbPersistence: IndexeddbPersistence) => void;
    sync: (idbPersistence: IndexeddbPersistence) => void;
  }> {
    constructor(docName: string, ydoc: Y.Doc);
    
    readonly doc: Y.Doc;
    readonly docName: string;
    readonly db: IDBDatabase | null;
    readonly synced: boolean;
    
    set(key: any, value: any): Promise<any>;
    get(key: any): Promise<any>;
    del(key: any): Promise<undefined>;
    destroy(): Promise<void>;
    clearData(): Promise<void>;
    
    on(event: 'synced', callback: (idbPersistence: IndexeddbPersistence) => void): void;
    on(event: 'sync', callback: (idbPersistence: IndexeddbPersistence) => void): void;
    once(event: 'synced', callback: (idbPersistence: IndexeddbPersistence) => void): void;
    once(event: 'sync', callback: (idbPersistence: IndexeddbPersistence) => void): void;
    off(event: 'synced', callback: (idbPersistence: IndexeddbPersistence) => void): void;
    off(event: 'sync', callback: (idbPersistence: IndexeddbPersistence) => void): void;
  }
}