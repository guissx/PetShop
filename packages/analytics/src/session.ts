import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
export const SESSION_SECONDS = 8 * 60 * 60;
export function signSession(secret: string, now=Date.now()) {
 if(secret.length<32) throw new Error('SESSION_SECRET precisa de pelo menos 32 caracteres.');
 const payload=Buffer.from(JSON.stringify({sub:'demo',exp:Math.floor(now/1000)+SESSION_SECONDS,nonce:randomBytes(16).toString('hex')})).toString('base64url');
 return payload+'.'+createHmac('sha256',secret).update(payload).digest('base64url');
}
export function verifySession(token: string | undefined, secret: string, now=Date.now()): boolean {
 if(!token || secret.length<32) return false;
 try { const parts=token.split('.');if(parts.length!==2)return false;
  const expected=createHmac('sha256',secret).update(parts[0]).digest();const signature=Buffer.from(parts[1],'base64url');
  if(signature.length!==expected.length || !timingSafeEqual(signature,expected))return false;
  const p=JSON.parse(Buffer.from(parts[0],'base64url').toString());
  return p.sub==='demo' && Number.isFinite(p.exp) && p.exp>Math.floor(now/1000) && p.exp<=Math.floor(now/1000)+SESSION_SECONDS;
 }catch{return false;}
}
export function constantEqual(a:string,b:string){const digest=(s:string)=>createHmac('sha256','petshop-credential-compare').update(s).digest();return timingSafeEqual(digest(a),digest(b));}
