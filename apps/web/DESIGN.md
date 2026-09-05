---
version: alpha
name: Nosso Aumigo
description: Painel executivo com tipografia editorial e indicadores de alto contraste.
colors:
  primary: '#202020'
  background: '#f5f5f5'
  surface: '#ffffff'
  text: '#191919'
  muted: '#585858'
  accent: '#b74d31'
  dark-background: '#111111'
  dark-surface: '#1c1c1c'
  dark-text: '#f4f4f4'
  dark-primary: '#ededed'
typography:
  sans:
    fontFamily: 'Source Sans 3 Variable, sans-serif'
  display:
    fontFamily: 'Manrope Variable, sans-serif'
rounded:
  DEFAULT: 8px
  lg: 12px
spacing:
  section-gap: 24px
  page-padding: 40px
components:
  button: {}
  card: {}
  select: {}
  table: {}
  map: {}
---

# Direção visual

Registro de produto: leitura executiva de dados, não página de marketing. Público e limites em PRODUCT.md. Interface pt-BR para uma rede baiana. Uso em desktop e consulta em celular.

A base usa branco, preto e cinzas, conforme a revisão solicitada pelo usuário. A receita é o ponto de entrada visual: superfície grafite no tema claro e cinza claro no tema escuro. Gráficos trazem azul, laranja, turquesa, lilás e rosa. Nas barras horizontais, cores distinguem posições visuais, sem codificar uma categoria global; os rótulos identificam cada dado. Manrope organiza títulos e números; Source Sans 3 mantém controles, tabelas e legendas legíveis.

## Tokens e propriedade

A fonte canônica de tokens é `src/app/globals.css`, incluindo todos os papéis semânticos e as substituições de `[data-theme=dark]`. Este documento descreve o sistema; não gera CSS. Gráficos e mapa usam as mesmas variáveis em SVG. As fontes são empacotadas localmente, sem chamada externa em runtime.

## Interação

Select compartilhado Radix em `filter-select.tsx`, com popup alinhado à largura do gatilho, lista rolável, seleção marcada e foco de teclado neutro discreto. O bloqueio de rolagem do Radix gerencia a compensação da barra: não duplicar a reserva com `scrollbar-gutter: stable`. Nenhum select nativo nos filtros. Contrato completo em UX-CONTRACT.md.

Tema controlado por `theme-provider.tsx`, persistido em cookie de preferência e lido no layout do servidor para evitar flash de tema incorreto. O tema se aplica também à tela de login e aos portais.

Mapa geográfico IBGE: câmera contínua de 1,65 segundo com aceleração e desaceleração, realce do ponto e legenda de cidade. Clique no mapa inicia a transição imediatamente. Com movimento reduzido, a câmera e os detalhes mudam sem transição. Seleção equivalente por teclado e botões de cidade.

## Verificação

Build de produção e TypeScript passaram após a implementação. Chromium local autorizado pelo usuário: `npm run test:ui` passou para temas, persistência, menus abertos, largura do popup, teclado, câmera intermediária e final, movimento reduzido, celular e ausência de erros no navegador. Capturas revisadas em `.artifacts/` na raiz. A auditoria Premium em modo estrito terminou sem achados. O detector Impeccable registrou avisos de documentação de tons e raios: o CSS é a fonte canônica completa, enquanto o frontmatter acima registra a paleta principal.
