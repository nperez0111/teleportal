================================================
FILE: README.md
================================================

# Simple Attribution Server

Stop-gap solution to storing & retrieving attributions and versions in Yjs@v14. This simple
server only requires an S3 endpoint, which can be configured using environment
variables.

```
npx y-simple-attribution-server --port 4000
```

```env
# Configure s3 endpoint via environment variables
S3_ENDPOINT=127.0.0.1
S3_PORT=9000
S3_SSL=false
S3_BUCKET=test-attributions
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
```

## testing

For testing, you may use the included minio s3 server, and the testing
configuration.

```
npm run minio
npm start
```

## Terminology

- `version`: refers to the state of a Yjs document at a point in time.
- `delta`: a general-purpose changeset representation from the `lib0` project.
It can be used to describe the (attributed) differences between two versions.
- `attribution`: A change may be attributed to a user/AI agent, a timestamp,
and other properties. The delta format can describe attributed changes.

## API

- `GET /attributions/{:docid}` - retrieve all attributions for a specific document
- `POST /attribute/{:docid}?user=userid&timestamp=number body:octet-stream` -
Attribute an update by sending the binary encoded Yjs update, alongside userid
and an optional timestamp, which will be associated with the change. You may add
more custom attributes as URL query parameters. They will be prefixed with a `_`
to avoid collisions with Yjs-native attributes.
- `POST /version/{:docid}` - create a new version of a document by posting the
binary encoded Yjs document.
- `GET /version-deltas/{:docid}` - the differences between all versions (in the
JSON-encoded delta format)

## Usage

An existing Yjs backend may use the simple attribution server to attribute all
incoming changes to the user. Whenever it receives a change, it should send a
`POST /attribute/{:docid}?user=userid body:yjs-update` request to
y-simple-attribution-server.

The client may later retrieve all attributions by calling `GET
/attributions/{:docid}`. This request returns an encoded `IdMap`, which maps
change-ranges to attributes.

The client can use the attributions to render who created which content. It can
also use the attributions to render the attributed differences between two
versions.

The client can also request the history of all (attributed) changes for a
document by calling `GET /version-deltas/{:docid}`

## Docker

```
# configure the environment variables in `compose.yaml` to your s3-compatible backend
docker compose up
```

================================================
FILE: compose.yaml
================================================

services:
  app:
    build: .
    ports:
      - "4000:4000"
    environment:
      - PORT=4000
      - S3_ENDPOINT=minio
      - S3_PORT=9000
      - S3_SSL=false
      - S3_BUCKET=test-attributions
      - S3_ACCESS_KEY=minioadmin
      - S3_SECRET_KEY=minioadmin

================================================
FILE: Dockerfile
================================================

FROM node:22-alpine

WORKDIR /app

# ENV PORT=4000 \

# S3_ENDPOINT=127.0.0.1 \

# S3_PORT=9000 \

# S3_SSL=false \

# S3_BUCKET=test-attributions \

# S3_ACCESS_KEY=minioadmin \

# S3_SECRET_KEY=minioadmin

COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 4000
CMD ["npm", "start"]

================================================
FILE: LICENSE
================================================

The MIT License (MIT)

Copyright (c) 2025 Kevin Jahns <kevin.jahns@protonmail.com>.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

================================================
FILE: package.json
================================================

{
  "name": "simple-attribution-server",
  "version": "1.0.0",
  "description": "A simple attribution server that can work alongside an existing yjs backend",
  "type": "module",
  "bin": {
    "y-simple-attribution-server": "./src/index.js"
  },
  "scripts": {
    "start": "node ./src/index.js",
    "test": "node --env-file .env.testing tests/index.js",
    "debug": "node --inspect-brk --env-file .env.testing tests/index.js",
    "minio": "docker run -p 9000:9000 -p 9001:9001 quay.io/minio/minio server /data --console-address \":9001\"",
    "lint": "standard && tsc --skipLibCheck"
  },
  "keywords": [
    "yjs"
  ],
  "author": "Kevin Jahns <kevin.jahns@protonmail.com>",
  "license": "MIT",
  "dependencies": {
    "@koa/router": "^14.0.0",
    "koa": "^3.1.1",
    "lib0": "^0.2.115-2",
    "minio": "^8.0.6",
    "yjs": "^14.0.0-14"
  },
  "devDependencies": {
    "@types/koa": "^3.0.1",
    "@types/koa__router": "^12.0.5",
    "concurrently": "^9.2.1",
    "standard": "^17.1.2",
    "typescript": "^5.9.3"
  }
}

================================================
FILE: tsconfig.json
================================================

{
  "compilerOptions": {
    "target": "esnext",
    "lib": ["ESNext", "dom"],
    "module": "nodenext",
    "allowJs": true,
    "checkJs": true,
    "declaration": true,
    "declarationMap": true,
    "outDir": "./dist",
    "baseUrl": "./",
    "rootDir": "./",
    "emitDeclarationOnly": true,
    "strict": true,
    "noImplicitAny": true,
    "moduleResolution": "nodenext",
    "paths": { }
  },
  "include": ["src/**/*.js", "tests/**/*.js"]
}

================================================
FILE: .env.testing
================================================

S3_ENDPOINT=127.0.0.1
S3_PORT=9000
S3_SSL=false
S3_BUCKET=test-attributions
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin

================================================
FILE: src/db.js
================================================

/**

- Attributions, versions, and Deltas are stored in binary form in an s3 bucket. The pattern for the filenames are:
- - attribution: y:v1:attrs:v1:${docid}:${timestamp}
- - version: y:v1:version:v1:${docid}:${timestamp}
- - version-delta: y:v1:vdelta:v1:${docid}:${timestamp}
-
- Versions are stored in binary form in an s3 bucket
-
- Due to concurrency, it may happen that multiple attribution-files for a single ydoc exist. These
- will be merged automatically.
 */

import *as Y from 'yjs'
import* as time from 'lib0/time'
import *as map from 'lib0/map'
import* as env from 'lib0/environment'
import *as number from 'lib0/number'
import* as queue from 'lib0/queue'
import *as promise from 'lib0/promise'
import* as math from 'lib0/math'
import *as minio from 'minio'
import* as delta from 'lib0/delta'

/**

- Minimum time (in ms) to cache messages before writing an update to s3.
 */
const minCacheTime = 5000
const s3endpoint = env.ensureConf('s3-endpoint')
const s3port = number.parseInt(env.ensureConf('s3-port'))
const s3useSSL = !['false', '0'].includes(env.getConf('s3-ssl') || 'false')
const s3accessKey = env.ensureConf('s3-access-key')
const s3secretKey = env.ensureConf('s3-secret-key')

export const minioClient = new minio.Client({
  endPoint: s3endpoint,
  port: s3port,
  useSSL: s3useSSL,
  accessKey: s3accessKey,
  secretKey: s3secretKey
})

const bucketName = env.ensureConf('s3-bucket')

/**

- @param {string} filename
- @return {Promise<Uint8Array<ArrayBuffer>>}
 */
const getBinaryFile = async (filename) => {
  const stream = await minioClient.getObject(bucketName, filename)
  return promise.create((resolve, reject) => {
    /**
  - @type {Buffer[]}
     */
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

/**

- @param {string} prefix
- @param {string} start
- @param {string?} end
- @return {Promise<string[]>}
 */
const getFilenamesWithPrefix = async (prefix, start = '', end = null) => {
  const stream = minioClient.listObjectsV2(bucketName, prefix, true, start)
  /**
  - @type {string[]}
   */
  const filenames = []
  for await (const obj of stream) {
    if (obj.name) {
      if (end != null && obj.name < end) { break }
      filenames.push(obj.name)
    }
  }
  return filenames
}

/**

- @param {string} docid
- @return {Promise<{ attributions: Y.IdMap<any>[], knownAttributionFileNames: string[] }>}
 */
export const getPersistedAttributions = async (docid) => {
  const knownAttributionFileNames = await getFilenamesWithPrefix(`y:v1:attrs:${docid}`)
  const attributions = await promise.all(knownAttributionFileNames.map(async filename => {
    const binAttr = await getBinaryFile(filename)
    return Y.decodeIdMap(binAttr)
  }))
  return { attributions, knownAttributionFileNames }
}

/**

- @param {string} docid
- @param {Uint8Array} bin
- @return {Promise<void>}
 */
export const storeVersion = async (docid, bin) => {
  await minioClient.putObject(bucketName, `y:v1:version:${docid}:${time.getUnixTime()}`, Buffer.from(bin))
}

/**

- @param {string} docid
- @param {number} timestamp
 */
export const getVersion = async (docid, timestamp) => getBinaryFile(`y:v1:version:${docid}:${timestamp}`)

/**

- @param {string} docid
 */
export const getVersionTimestamps = async (docid) => {
  const versionNames = await getFilenamesWithPrefix(`y:v1:version:${docid}`)
  const timestamps = versionNames.map(name =>
    number.parseInt(name.slice(name.lastIndexOf(':') + 1))
  )
  return timestamps
}

/**

- @param {string} docid
 */
export const getAllVersionDeltas = async (docid) => {
  const vtimes = await getVersionTimestamps(docid)
  debugger
  const ds = await promise.all(vtimes.map(async (timestamp, index) =>
    ({
      timestamp,
      delta: await getVersionDelta(docid, vtimes[index-1] || null, timestamp)
    })
  ))
  return ds
}

/**

- @param {Uint8Array} bin
 */
const binToYdoc = bin => {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, bin)
  return ydoc
}

/**

- @param {string} docid
- @param {number?} timestampFrom
- @param {number} timestampTo
 */
export const getVersionDelta = async (docid, timestampFrom, timestampTo) => {
  const [v1, v2] = await promise.all([
    timestampFrom != null ? getVersion(docid, timestampFrom).then(binToYdoc) : promise.resolveWith(new Y.Doc()),
    getVersion(docid, timestampTo).then(binToYdoc)
  ])
  const d = Y.diffDocsToDelta(v1, v2)
  return d
}

class MergeQueueItem extends queue.QueueNode {
  /**

- @param {string} docid
- @param {number} createdAt
   */
  constructor (docid, createdAt) {
    super()
    this.docid = docid
    this.createdAt = createdAt
  }
}
/**
- @type {queue.Queue<MergeQueueItem>}
 */
const mergeQueue = queue.create()
/**
- @type {Map<string,Y.IdMap<any>[]>}
 */
const cachedAttributions = new Map()
/**
- @param {string} docid
- @param {Y.IdMap<any>} attr
 */
export const scheduleAttributionForMerge = (docid, attr) => {
  if (map.setIfUndefined(cachedAttributions, docid, () => /**@type {Y.IdMap<any>[]}*/ ([])).push(attr) === 1) {
    // first added item, add this to the queue
    queue.enqueue(mergeQueue, new MergeQueueItem(docid, time.getUnixTime()))
  }
}

/**

- @param {string} docid
 */
export const getAttributions = async docid => {
  const { attributions: persistedAttrs } = await getPersistedAttributions(docid)
  const allAttrs = [...persistedAttrs, ...(cachedAttributions.get(docid) || [])]
  if (allAttrs.length > 0) {
    Y.insertIntoIdMap(allAttrs[0], Y.mergeIdMaps(allAttrs.slice(1)))
    return allAttrs[0]
  } else {
    return Y.createIdMap()
  }
}

/**

- This neverending loop consumes the mergeQueue
 */
export const persistenceLoop = async () => {
  while (true) {
    const qitem = queue.dequeue(mergeQueue)
    if (qitem == null) {
      await promise.wait(1000)
      continue
    }
    try {
      await promise.wait(math.max(minCacheTime - (time.getUnixTime() - qitem.createdAt), 0))
      const { attributions: persistedAttrs, knownAttributionFileNames } = await getPersistedAttributions(qitem.docid)
      const cachedAttrs = cachedAttributions.get(qitem.docid) || []
      const cacheLen = cachedAttrs.length
      const allAttrs = [...persistedAttrs, ...cachedAttrs]
      if (allAttrs.length > 0) {
        Y.insertIntoIdMap(allAttrs[0], Y.mergeIdMaps(allAttrs.slice(1)))
        const encAttrs = Y.encodeIdMap(allAttrs[0])
        await minioClient.putObject(bucketName, `y:v1:attrs:${qitem.docid}:${time.getUnixTime()}`, Buffer.from(encAttrs))
        await minioClient.removeObjects(bucketName, knownAttributionFileNames)
      }
      cachedAttrs.splice(0, cacheLen)
      if (cachedAttrs.length === 0) {
        cachedAttributions.delete(qitem.docid)
      } else {
        // more attrs were added, enqueue again
        queue.enqueue(mergeQueue, new MergeQueueItem(qitem.docid, time.getUnixTime()))
      }
    } catch (err) {
      console.error(err)
      // enqueue this again
      queue.enqueue(mergeQueue, new MergeQueueItem(qitem.docid, time.getUnixTime()))
    }
  }
}

================================================
FILE: src/index.js
================================================

# !/usr/bin/env node

import Koa from 'koa'
import Router from '@koa/router'
import *as Y from 'yjs'
import* as time from 'lib0/time'
import *as s from 'lib0/schema'
import* as env from 'lib0/environment'
import *as number from 'lib0/number'
import* as object from 'lib0/object'
import * as db from './db.js'
import v8 from 'v8'

/**

- @typedef {object} AttributedUpdate
- @property {Uint8Array} AttributedUpdate.update
- @property {string} AttributedUpdate.user
- @property {number} AttributedUpdate.timestamp
 */

const $attributedUpdate = s.$object({ update: s.$constructedBy(Uint8Array), user: s.$string, timestamp: s.$number })

const app = new Koa()
const router = new Router()

/**

- Define how many concurrent processes should run that sync the cached data with the database.
 */
const persistenceConcurrency = number.parseInt(env.getConf('persistence-concurrency') ?? '3')
for (let i = 0; i < persistenceConcurrency; i++) {
  db.persistenceLoop()
}

/**

- Return available heap-size.
-
- @return number
 */
const checkAvailableHeapSize = () => {
  const heapStats = v8.getHeapStatistics();
  const heapUsed = heapStats.used_heap_size;
  const heapLimit = heapStats.heap_size_limit* .90 // use 90 percent of heap limit max
  return heapLimit - heapUsed
}

/**

- @param {Koa.Context} ctx
 */
const getRawBody = async ctx => {
  const chunks = []
  for await (const chunk of ctx.req) {
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

router.post('/attribute/:docid', async ctx => {
  const { docid } = ctx.params
  let { user, timestamp = time.getUnixTime(), ...customQuery } = ctx.query
  if (s.$string.check(timestamp)) {
    timestamp = number.parseInt(timestamp)
  }
  const updateBuf = await getRawBody(ctx)
  if (!updateBuf.length) {
    ctx.throw(400, 'Missing update data in request body')
  }
  const update = new Uint8Array(updateBuf)
  if (!$attributedUpdate.check({ update, user, timestamp })) {
    return ctx.throw(400, 'Expecting parameters: user:string, timestamp:number?')
  }
  if (checkAvailableHeapSize() - (update.byteLength * 100) < 0) {
    return ctx.throw(500, 'Out of memory - rejecting update because there is not emough memory available.')
  }
  try {
    const updateParsed = Y.readUpdateIdRanges(update)
    const attributions = Y.createIdMapFromIdSet(updateParsed.inserts, [Y.createAttributionItem('insert', user), Y.createAttributionItem('insertAt', timestamp)])
    Y.insertIntoIdMap(attributions, Y.createIdMapFromIdSet(updateParsed.deletes, [Y.createAttributionItem('delete', user), Y.createAttributionItem('deleteAt', timestamp)]))
    if (!object.isEmpty(customQuery)) {
      const allChanges = Y.mergeIdSets([updateParsed.inserts, updateParsed.deletes])
      const customAttrs = object.map(customQuery, (val, key) => {
        s.$string.expect(val)
        return Y.createAttributionItem('_' + key, val)
      })
      Y.insertIntoIdMap(attributions, Y.createIdMapFromIdSet(allChanges, customAttrs))
    }
    db.scheduleAttributionForMerge(docid, attributions)
  } catch (err) {
    const errMessage = 'failed to parse update'
    console.error(errMessage)
    return ctx.throw(400, errMessage)
  }
  ctx.body = {
    success: true
  }
})

router.get('/attributions/:docid', async ctx => {
  const docid = ctx.params.docid
  const attributions = await db.getAttributions(docid)
  ctx.body = Buffer.from(Y.encodeIdMap(attributions))
  ctx.type = 'application/octet-stream'
})

router.post('/version/:docid', async ctx => {
  const docid = ctx.params.docid
  try {
    const docContentBuf = await getRawBody(ctx)
    if (!docContentBuf.length) {
      ctx.throw(400, 'Missing ydoc data in request body')
    }
    const docContent = new Uint8Array(docContentBuf)
    await db.storeVersion(docid, docContent)
    ctx.body = {
      success: true
    }
  } catch (e) {
    return ctx.throw(400, 'unexpected error while parsing version: ' + e)
  }
})

router.get('/version-deltas/:docid', async ctx => {
  const docid = ctx.params.docid
  const ds = await db.getAllVersionDeltas(docid)
  ctx.body = {
    deltas: ds.map(d => ({
      timestamp: d.timestamp,
      delta: d.delta.toJSON()
    }))
  }
  ctx.type = 'application/octet-stream'
})

app
  .use(router.routes())
  .use(router.allowedMethods())

export const port = number.parseInt(env.getParam('port', '4000'))
app.listen(port)

================================================
FILE: tests/basic.tests.js
================================================

import *as t from 'lib0/testing'
import* as Y from 'yjs'
import *as env from 'lib0/environment'
import { port } from '../src/index.js'
import* as db from '../src/db.js'

const baseUrl = `http://localhost:${port}`

/**

- @param {string} bucketName
 */
const ensureCleanBucket = async bucketName => {
  const exists = await db.minioClient.bucketExists(bucketName)
  if (exists) {
    const objectsList = []
    const stream = db.minioClient.listObjectsV2(bucketName, '', true)
    for await (const obj of stream) {
      objectsList.push(obj.name)
    }
    if (objectsList.length > 0) {
      await db.minioClient.removeObjects(bucketName, objectsList)
    }
  } else {
    // Create the bucket
    await db.minioClient.makeBucket(bucketName)
  }
}

const bucketName = env.ensureConf('s3-bucket')
await ensureCleanBucket(bucketName)

/**

- Send an update to the attribution API
- @param {string} docid
- @param {string} user
- @param {Uint8Array} update
- @param {{[key:string]:string}} customAttrs
- @returns {Promise<void>}
 */
const sendUpdate = async (docid, user, update, customAttrs = {}) => {
  const queryParams = new URLSearchParams({ user, ...customAttrs })
  const url = `${baseUrl}/attribute/${docid}?${queryParams}`
  const response = await fetch(url, {
    method: 'POST',
    body: /**@type {Uint8Array<ArrayBuffer>}*/ (update),
    headers: {
      'Content-Type': 'application/octet-stream'
    }
  })
  if (!response.ok) {
    throw new Error(`[${url}]: API error: ${response.status} ${response.statusText}`)
  }
  return await response.json()
}

/**

- Store a version.
- @param {string} docid
- @param {Uint8Array<ArrayBuffer>} doc
- @returns {Promise<void>}
 */
const storeVersion = async (docid, doc) => {
  const url = `${baseUrl}/version/${docid}`
  const response = await fetch(url, {
    method: 'POST',
    body: doc,
    headers: {
      'Content-Type': 'application/octet-stream'
    }
  })
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }
  return await response.json()
}

/**

- @param {string} docid
- @returns {Promise<any>}
 */
const getVersionDeltas = async (docid) => {
  const url = `${baseUrl}/version-deltas/${docid}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`)
  }
  return await response.json()
}

/**

- @param {string} docid
- @return {Promise<Y.IdMap<any>>}
 */
const fetchAttributions = async docid => {
  const url = `${baseUrl}/attributions/${docid}`
  const response = await fetch(url)
  const binAttrs = await response.bytes()
  const attrs = Y.decodeIdMap(binAttrs)
  return attrs
}

/**

- @param {t.TestCase} _tc
 */
export const testSimpleRequest = async_tc => {
  const docid = 'testdoc'
  const ydoc = new Y.Doc()
  ydoc.getText().insert(0, 'hi there')
  const update = Y.encodeStateAsUpdate(ydoc)
  await sendUpdate(docid, 'user53', update)
  const attrsFetched = await fetchAttributions(docid)
  t.assert(attrsFetched.clients.size > 0)
  const clientAttrs = attrsFetched.clients.get(ydoc.clientID)?.getIds() || []
  t.assert(clientAttrs.length === 1)
  t.assert(clientAttrs[0].attrs.length === 2)
  t.assert(clientAttrs[0].attrs[0].name === 'insert')
  t.assert(clientAttrs[0].attrs[1].name === 'insertAt')
}

/**

- @param {t.TestCase} _tc
 */
export const testCustomAttr = async_tc => {
  const docid = _tc.testName
  const ydoc = new Y.Doc()
  ydoc.getText().insert(0, 'hi there')
  const update = Y.encodeStateAsUpdate(ydoc)
  await sendUpdate(docid, 'user53', update, { myCustomAttr: '42' })
  const attrsFetched = await fetchAttributions(docid)
  t.assert(attrsFetched.clients.size > 0)
  const clientAttrs = attrsFetched.clients.get(ydoc.clientID)?.getIds() || []
  t.assert(clientAttrs.length === 1)
  t.assert(clientAttrs[0].attrs.length === 3)
  t.assert(clientAttrs[0].attrs[2].name === '_myCustomAttr')
  t.assert(clientAttrs[0].attrs[2].val === '42')
}

/**

- @param {t.TestCase} _tc
 */
export const testVersionStore = async_tc => {
  const docid = _tc.testName
  const ydoc = new Y.Doc()
  ydoc.getText('ytext').insert(0, 'hello')
  await storeVersion(docid, Y.encodeStateAsUpdate(ydoc))
  ydoc.getText('ytext').insert(5, 'world!')
  await storeVersion(docid, Y.encodeStateAsUpdate(ydoc))
  const ds = await getVersionDeltas(docid)
  console.log('deltas', JSON.stringify(ds.deltas, null, 2))
  debugger
}

================================================
FILE: tests/index.js
================================================

/*eslint-env node*/
import * as basic from './basic.tests.js'

import { runTests } from 'lib0/testing'
import { isBrowser, isNode } from 'lib0/environment'
import * as log from 'lib0/logging'

if (isBrowser) {
  log.createVConsole(document.body)
}

const tests = {
  basic
}

const run = async () => {
  const success = await runTests(tests)
  /*istanbul ignore next*/
  if (isNode) {
    process.exit(success ? 0 : 1)
  }
}
run()
