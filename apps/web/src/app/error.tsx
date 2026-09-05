'use client';
export default function ErrorPage({reset}:{reset:()=>void}){return <main className="loading-page"><h1>Não conseguimos abrir este painel.</h1><p>Tente novamente em instantes.</p><button className="primary" onClick={reset}>Tentar novamente</button></main>;}
