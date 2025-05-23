import * as fs from "fs";
import * as os from "os";
import * as pathLib from "path";
import { TextEncoder } from "util";

type ChunkDataType = string | Chunk[] | number | Date;

/**
 * Datastructure for saving Dom Objects
 */
class Chunk {
  public data?: ChunkDataType;
  public length: number = 0;
  public tag: string;

  public constructor(length: number, tag: string, data?: ChunkDataType) {
    this.length = length;
    this.tag = tag;
    this.data = data;
  }
}

/**
 * Interface for song data in sessions
 */
export interface Song {
  title: string,
  artist: string,
  filePath: string,
  bpm?: number,
}
/**
 * Interface for song data in sessions
 */
export interface HistorySong extends Song {
  timePlayed: Date,
}

/**
 * Interface for session data
 */
export interface Session {
  date: string,
  songs: HistorySong[]
}

/**
 * Converts a 4 byte string into a integer
 * @param {string} s 4 byte string to be converted
 */
export function getUInt32FromString(s: string) {
  return (
    (s.charCodeAt(0) << 24) +
    (s.charCodeAt(1) << 16) +
    (s.charCodeAt(2) << 8) +
    s.charCodeAt(3)
  );
}

/**
 * Converts a 4 byte integer into a string
 * @param {number} n 4 byte integer
 */
export function getStringFromUInt32(n: number) {
  return (
    String.fromCharCode(Math.floor(n / (1 << 24)) % 256) +
    String.fromCharCode(Math.floor(n / (1 << 16)) % 256) +
    String.fromCharCode(Math.floor(n / (1 << 8)) % 256) +
    String.fromCharCode(Math.floor(n) % 256)
  );
}

/**
 * Returns a single buffer and fills in data tag recursivly
 * @param {Buffer} buffer A node.js fs buffer to read from
 * @param {number} index index of first byte
 * @returns {Promise<{ chunk: Chunk; newIndex: number }>} Promise with object for destructured assignment. New Index is the index of the following chunk
 */
async function parseChunk(
  buffer: Buffer,
  index: number
): Promise<{ chunk: Chunk; newIndex: number }> {
  const tag = getStringFromUInt32(buffer.readUInt32BE(index));
  const length = buffer.readUInt32BE(index + 4);
  let data;
  switch (tag) {
    case "oses": // Structure containing a adat session object
    case "oent": // Structure containing a adat song object
    case "otrk": // Structure containing a ttyp song object
    case "adat": // Strcuture containg an array of chunks
      data = await parseChunkArray(buffer, index + 8, index + 8 + length);
      break;
    case "\u0000\u0000\u0000\u0001":
    case "\u0000\u0000\u0000\u000f":
      data = buffer.readUInt32BE(index + 8);
      break;
    case "\u0000\u0000\u00005":
      const secondsSince1970 = buffer.readUInt32BE(index + 8);
      data = new Date(0);
      data.setUTCSeconds(secondsSince1970);
      break;
    default:
      const le = buffer.subarray(index + 8, index + 8 + length);
      for (let i = 0; i < le.byteLength; i += 2) {
        const a = le[i];
        const b = le[i + 1];
        le[i] = b;
        le[i + 1] = a;
      }
      data = le.toString("utf-16le");
      break;
  }
  return {
    chunk: new Chunk(length, tag, data),
    newIndex: index + length + 8
  };
}

/**
 * Reads in a ongoing list of serato chunks till the maximum length is reached
 * @param {Buffer} buffer A node.js fs buffer to read from
 * @param {number} start Index of the first byte of the chunk
 * @param {number} end Maximum length of the array data
 * @returns {Promise<Chunk[]>} Array of chunks read in
 */
async function parseChunkArray(
  buffer: Buffer,
  start: number,
  end: number
): Promise<Chunk[]> {
  const chunks = [];
  let cursor = start;
  while (cursor < end) {
    const { chunk, newIndex } = await parseChunk(buffer, cursor);
    cursor = newIndex;
    chunks.push(chunk);
  }
  return chunks;
}

/**
 * Encodes a chunk array into a buffer
 * @param {fs.promises.FileHandle} fd Filehandle to write to
 * @param {Chunk[]} chunks Array of chunks to be written
 */
async function encodeChunkArray(
  fd: fs.promises.FileHandle,
  chunks: Chunk[],
  offset: number = 0
) {
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const tagBuffer = Buffer.alloc(4);
    const sizeBuffer = Buffer.alloc(4);
    tagBuffer.write(chunk.tag, 'ascii');
    sizeBuffer.writeUInt32BE(0, 0);
    await fd.write(tagBuffer, 0, 4, offset);
    offset += 4;
    await fd.write(sizeBuffer, 0, 4, offset);
    offset += 4;

    const startRefOffset = offset;
    let dataLength = 0;

    if (chunk.tag === 'oses' || chunk.tag === 'oent' || chunk.tag === 'otrk' || chunk.tag === 'adat') {
      offset = await encodeChunkArray(fd, chunk.data as Chunk[], offset);
      dataLength = offset - startRefOffset;
    } else if (chunk.tag === '\u0000\u0000\u0000\u0001' || chunk.tag  === '\u0000\u0000\u0000\u000f') {
      const data = Buffer.alloc(4);
      data.writeUInt32BE(chunk.data as number, 0);
      await fd.write(data, 0, 4, offset);
      offset += 4;
      dataLength = 4;
    } else if (chunk.tag === '\u0000\u0000\u00005') {
      const data = Buffer.alloc(4);
      const date = chunk.data as Date;
      const secondsSince1970 = Math.floor(date.getTime() / 1000);
      data.writeUInt32BE(secondsSince1970, 0);
      await fd.write(data, 0, 4, offset);
      offset += 4;
      dataLength = 4;
    } else {
      const data = Buffer.from(chunk.data as string, 'utf16le');
      const beBuffer = Buffer.alloc(data.byteLength);
      for (let j = 0; j < data.byteLength; j += 2) {
        const a = data[j];
        const b = data[j + 1];
        beBuffer[j] = b;
        beBuffer[j + 1] = a;
      }
      await fd.write(beBuffer, 0, beBuffer.byteLength, offset);
      offset += beBuffer.byteLength;
      dataLength = beBuffer.byteLength;
    }

    sizeBuffer.writeUInt32BE(dataLength, 0);
    await fd.write(sizeBuffer, 0, 4, startRefOffset - 4);
  }

  return offset;
}

/**
 * Returns the raw domtree of a serato file
 * @param {string} path The path to the file that shoud be parsed
 * @returns {Promise<Chunk[]>} Nested object dom
 */
export async function getDomTree(path: string): Promise<Chunk[]> {
  const buffer = await fs.promises.readFile(path);
  const chunks = await parseChunkArray(buffer, 0, buffer.length);

  return chunks;
}

/**
 * Reads in a history.databases file
 * @param {string} path Path to the history.database file
 * @returns {Promise<{ [Key: string]: number }>} A dictonary with the number of the session file for every date
 */
export async function getSessions(
  path: string
): Promise<{ [Key: string]: number }> {
  const buffer = await fs.promises.readFile(path);
  const chunks = await parseChunkArray(buffer, 0, buffer.length);

  const sessions: { [Key: string]: number } = {};
  chunks.forEach(chunk => {
    if (chunk.tag === "oses") {
      if (Array.isArray(chunk.data)) {
        if (chunk.data[0].tag === "adat") {
          if (Array.isArray(chunk.data[0].data)) {
            let date = "";
            let index = -1;
            chunk.data[0].data.forEach(subChunk => {
              if (subChunk.tag === "\u0000\u0000\u0000\u0001") {
                index = subChunk.data as number;
              }
              if (subChunk.tag === "\u0000\u0000\u0000)") {
                date = subChunk.data as string;
              }
            });
            sessions[date] = index;
          }
        }
      }
    }
  });
  return sessions;
}

/**
 * Reads in a serato session file.
 * @param {string} path Path to *.session file
 * @returns {Promise<SessionSong[]>} An array containing title and artist for every song played
 */
export async function getSessionSongs(
  path: string
): Promise<HistorySong[]> {
  const buffer = await fs.promises.readFile(path);
  const chunks = await parseChunkArray(buffer, 0, buffer.length);

  const songs: HistorySong[] = [];

  chunks.forEach(chunk => {
    if (chunk.tag === "oent") {
      if (Array.isArray(chunk.data)) {
        if (chunk.data[0].tag === "adat") {
          if (Array.isArray(chunk.data[0].data)) {
            let title = "";
            let artist = "";
            let bpm;
            let filePath = "";
            let timePlayed = new Date();
            chunk.data[0].data.forEach(subChunk => {
              if (subChunk.tag === "\u0000\u0000\u0000\u0006") {
                title = subChunk.data as string;
              }
              if (subChunk.tag === "\u0000\u0000\u0000\u0007") {
                artist = subChunk.data as string;
              }
              if (subChunk.tag === "\u0000\u0000\u0000\u000f") {
                bpm = subChunk.data as number;
              }
              if (subChunk.tag === "pfil") {
                filePath = subChunk.data as string;
              }
              if (subChunk.tag === "\u0000\u0000\u00005") {
                timePlayed = subChunk.data as Date;
              }
            });
            // console.log(chunk.data[0].data); // For Development
            songs.push({ title, artist, bpm, filePath, timePlayed });
          }
        }
      }
    }
  });
  return songs;
}

/**
 * Gets all songs of the database v2 serato file
 * @param {string} path path to database v2 serato file
 */
export async function getSeratoSongs(path: string) {
  const buffer = await fs.promises.readFile(path);
  const chunks = await parseChunkArray(buffer, 0, buffer.length);

  const songs: Song[] = [];

  chunks.forEach(chunk => {
    if (chunk.tag === "otrk") {
      if (Array.isArray(chunk.data)) {
        let title = "";
        let artist = "";
        let bpm;
        let filePath = "";
        chunk.data.forEach(subChunk => {
          if (subChunk.tag === "tsng") {
            title = subChunk.data as string;
          }
          if (subChunk.tag === "tart") {
            artist = subChunk.data as string;
          }
          if (subChunk.tag === "tbpm") {
            bpm = subChunk.data as string;
          }
          if (subChunk.tag === "pfil") {
            filePath = subChunk.data as string;
          }
        });
        songs.push({ title, artist, bpm, filePath });
      }

    }
  });

  return songs;
}

export async function getChunks(path: string) {
  const buffer = await fs.promises.readFile(path);
  return await parseChunkArray(buffer, 0, buffer.length);
}

/**
 * Sets new songs to the serato database v2 file
 * @param {string} path path to database v2 serato file
 * @param {Chunk[]} chunks array of songs to be added
 */
export async function setSeratoSongs(path: string, chunks: Chunk[]) {
  const fd = await fs.promises.open(path, 'w+');
  await encodeChunkArray(fd, chunks);
  await fd.close();
}

/**
 * Reads all sessions and played songs from the _Serato_ folder
 * @param {string} seratoPath path to _Serato_ folder (including _Serato_)
 * @returns {Promise<Session[]>} list of sessions including songs
 */
export async function getSeratoHistory(seratoPath: string): Promise<Session[]> {
  const sessions = await getSessions(pathLib.join(seratoPath, 'History/history.database'))
  const result: Session[] = []

  for (const key in sessions) {
    if (sessions.hasOwnProperty(key)) {
      const session = sessions[key];
      const songlist = await getSessionSongs(pathLib.join(seratoPath, 'History/Sessions/', session + '.session'))
      result.push({ date: key, songs: songlist })
    }
  }
  return result;
}

/**
 * Returns the default path to the _serato_ folder of the user
 * @returns {string} path to _serato_ folder
 */
export function getDefaultSeratoPath(): string {
  return pathLib.join(os.homedir(), 'Music/_Serato_/');
}

// getSessionSongs('/Users/tobiasjacob/Music/_Serato_/History/Sessions/12.session'); // for testing

// getSessions('/Users/tobiasjacob/Music/_Serato_/History/history.database'); // for testing
