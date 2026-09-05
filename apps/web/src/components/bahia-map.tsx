'use client';

import {useEffect,useState} from 'react';
import {AnimatePresence,motion,useReducedMotion} from 'motion/react';
import {ArrowUpRight,Compass,MapPin,RotateCcw} from 'lucide-react';
import geometry from '@/assets/bahia.json';
import {stores} from '@petshop/analytics';

const project=([lon,lat]:number[])=>[(lon+46.9)*49,(-lat-8.45)*49];
const polygons=geometry.features.flatMap(f=>f.geometry.type==='MultiPolygon'
  ?f.geometry.coordinates as unknown as number[][][][]
  :[f.geometry.coordinates as unknown as number[][][]]);
const outline=polygons.flatMap(p=>p.map(r=>r.map((v,i)=>`${i?'L':'M'}${project(v).join(',')}`).join(' ')+'Z')).join(' ');
const points=stores.map(store=>({...store,point:project([store.lon,store.lat])}));
const route=points.map((s,i)=>`${i?'L':'M'}${s.point.join(',')}`).join(' ')+' Z';

export default function BahiaMap({selected,onSelect}:{selected:number;onSelect:(id:number)=>void}){
  const reduced=useReducedMotion();
  const [camera,setCamera]=useState(selected);
  useEffect(()=>{setCamera(selected);},[selected]);
  const active=points.find(s=>s.id===camera);
  const view=active?`${active.point[0]-130} ${active.point[1]-130} 260 280`:'-20 -15 560 580';
  const zoom=active?260/560:1;
  function select(id:number){setCamera(id);onSelect(id);}

  return <div className={`map-wrap ${active?'map-focused':''}`}>
    <div className="map-heading"><span><MapPin size={16}/> Bahia, Brasil</span><span className="map-count">3 filiais</span></div>
    <motion.svg className="geo-map" initial={false} animate={{viewBox:view}}
      transition={{duration:reduced?0:1.65,ease:[.76,0,.24,1]}}
      role="group" aria-label="Mapa da Bahia com as filiais Salvador, Itabuna e Feira de Santana">
      <defs>
        <pattern id="geo-grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M 30 0 L 0 0 0 30" fill="none" className="map-gridline" strokeWidth=".5"/></pattern>
      </defs>
      <rect x="-600" y="-600" width="1600" height="1600" className="map-ocean"/>
      <rect x="-600" y="-600" width="1600" height="1600" fill="url(#geo-grid)"/>
      <path d={outline} className="map-land" strokeWidth="1" vectorEffect="non-scaling-stroke" fillRule="evenodd"/>
      <motion.text x="180" y="235" className="map-state-label" fontSize="25" letterSpacing="8" animate={{opacity:active?0:.22}} transition={{duration:reduced?0:.3}}>BAHIA</motion.text>
      <text x="436" y="397" className="map-ocean-label" fontSize="10" transform="rotate(-72 436 397)">OCEANO ATLÂNTICO</text>
      <motion.path d={route} className="map-network-area" initial={{opacity:0}} animate={{opacity:1}} transition={{duration:reduced?0:.8,delay:reduced?0:.6}} aria-hidden="true"/>
      <motion.path d={route} className="map-route" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" initial={{pathLength:0}} animate={{pathLength:1}} transition={{duration:reduced?0:1.6,delay:reduced?0:.2,ease:'easeInOut'}} aria-hidden="true"/>
      {points.map(s=>{
        const [x,y]=s.point;const current=camera===s.id;const labelLeft=s.id===3;
        return <g key={s.id} className="map-pin" role="button" tabIndex={0} aria-label={`Ver filial ${s.name}`} aria-pressed={current}
          onClick={()=>select(s.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(s.id);}}}>
          <title>{`${s.name} · selecionar filial`}</title>
          <motion.circle cx={x} cy={y} initial={false} animate={{r:24*zoom,opacity:current?.2:.1}} transition={{duration:reduced?0:1.3}} className="map-marker-halo"/>
          <motion.circle cx={x} cy={y} initial={false} animate={{r:current?9*zoom:6*zoom}} transition={{duration:reduced?0:1.3}} className={current?'map-marker selected':'map-marker'} strokeWidth="3" vectorEffect="non-scaling-stroke"/>
          <motion.text x={x} y={y} initial={false}
            animate={{fontSize:13*zoom,dx:(labelLeft?-16:16)*zoom,dy:(labelLeft?-12:5)*zoom,opacity:active&&!current?0:1}}
            transition={{duration:reduced?0:1.3}} textAnchor={labelLeft?'end':'start'} className="map-city-label">{s.name}</motion.text>
        </g>;
      })}
    </motion.svg>
    <div className="map-compass"><Compass size={24}/><span>N</span></div>
    <AnimatePresence mode="wait">
      <motion.div key={camera} className="map-caption" initial={{opacity:0,y:12}} animate={{opacity:1,y:0}} exit={{opacity:0,y:-8}} transition={{duration:reduced?0:.35,delay:reduced?0:.15}}>
        <span>{active?'Filial selecionada':'Explore nossa presença'}</span><strong>{active?active.name:'Onde o cuidado acontece.'}</strong>
        <p>{active?'Resultados da cidade no painel ao lado.':'Escolha uma cidade para se aproximar.'}</p>
      </motion.div>
    </AnimatePresence>
    <button className="map-reset" onClick={()=>select(0)}><RotateCcw size={15}/> Visão estadual</button>
    <span className="map-source">IBGE · localização das cidades <ArrowUpRight size={10}/></span>
  </div>;
}
