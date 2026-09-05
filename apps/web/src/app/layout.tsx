import type {Metadata} from 'next';
import {cookies} from 'next/headers';
import {ThemeProvider} from '@/components/theme-provider';
import '@fontsource-variable/manrope';
import '@fontsource-variable/source-sans-3';
import './globals.css';
export const metadata:Metadata={title:'Nosso Aumigo | Visão de negócio',description:'Uma visão clara dos resultados da rede Pet Shop Nosso Aumigo.',robots:{index:false,follow:false}};
export default async function RootLayout({children}:{children:React.ReactNode}){
 const theme=(await cookies()).get('petshop_theme')?.value==='dark'?'dark':'light';
 return <html lang="pt-BR" data-theme={theme} style={{colorScheme:theme}}><body><ThemeProvider initialTheme={theme}>{children}</ThemeProvider></body></html>;
}
