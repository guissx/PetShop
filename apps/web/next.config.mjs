import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
try { loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
export default {
  transpilePackages: ['@petshop/analytics'],
  poweredByHeader: false,
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
  async headers() { return [{ source: '/:path*', headers: [
    {key:'X-Content-Type-Options',value:'nosniff'},
    {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
    {key:'X-Frame-Options',value:'DENY'}
  ]}]; }
};
