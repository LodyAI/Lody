export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const CHUNK_CHARACTERS = 16384;
export function createSender(post) {
  let sequence = 0;
  return message => {
    const text = JSON.stringify(message);
    if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
      post(JSON.stringify({type:'bridgeError',code:'message_too_large'})); return;
    }
    if (text.length <= CHUNK_CHARACTERS) { post(text); return; }
    const id = String(++sequence), total = Math.ceil(text.length / CHUNK_CHARACTERS);
    for (let index = 0; index < total; index++) {
      post(JSON.stringify({type:'bridgeChunk',id,index,total,data:text.slice(index*CHUNK_CHARACTERS,(index+1)*CHUNK_CHARACTERS)}));
    }
  };
}
