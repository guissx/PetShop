'use client';

import {createContext,useContext,useState} from 'react';
import {Moon,Sun} from 'lucide-react';

type Theme='light'|'dark';
const ThemeContext=createContext<{theme:Theme;toggle:()=>void}>({theme:'light',toggle:()=>{}});

export function ThemeProvider({initialTheme,children}:{initialTheme:Theme;children:React.ReactNode}) {
  const [theme,setTheme]=useState(initialTheme);
  function toggle(){
    const next=theme==='dark'?'light':'dark';
    document.documentElement.dataset.theme=next;
    document.documentElement.style.colorScheme=next;
    document.cookie=`petshop_theme=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    setTheme(next);
  }
  return <ThemeContext.Provider value={{theme,toggle}}>{children}</ThemeContext.Provider>;
}

export function ThemeToggle(){
  const {theme,toggle}=useContext(ThemeContext);
  return <button type="button" className="theme-toggle" onClick={toggle} aria-label={theme==='light'?'Ativar tema escuro':'Ativar tema claro'} title={theme==='light'?'Tema escuro':'Tema claro'}>
    {theme==='light'?<Moon size={18}/>:<Sun size={18}/>}<span>{theme==='light'?'Escuro':'Claro'}</span>
  </button>;
}
