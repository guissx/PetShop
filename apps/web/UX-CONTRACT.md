# Contrato de interface

| Capacidade | Responsável canônico | Comportamento |
| --- | --- | --- |
| Select/listbox | `src/components/filter-select.tsx`, Radix Select | Enter e Espaço abrem; setas navegam; digitação busca; Escape fecha e devolve foco; seleção atual marcada; portal usa o tema global. |
| Tema | `src/components/theme-provider.tsx` | Botão com nome acessível para o tema de destino; preferência em cookie; render inicial consistente no servidor. |
| Tokens e scrollbar | `src/app/globals.css` | Cores semânticas para ambos os temas, foco visível e rolagem de listas e tabelas. |
| Filtros analíticos | `src/components/dashboard.tsx` | URL é a fonte persistente; manter dados existentes durante transição e indicar consulta pendente. |
| Mapa | `src/components/bahia-map.tsx` | Cidade acessível por clique, Enter ou Espaço; retorno estadual; movimento reduzido; pontos representam cidades. |
| Gráficos | `src/components/charts.tsx` | Cores por token, valores pt-BR, tooltip legível em ambos os temas; rankings empatados ordenados por nome. |

Seleção e foco são estados distintos. Não remover indicador de teclado para atender a uma preferência estética. Menus não podem ficar atrás de gráficos. Layout móvel deve acomodar filtros sem rolagem horizontal da página.

Abrir um select deve preservar a posição horizontal e a largura do conteúdo. Alterações de filtros usam `router.push` com `scroll: false`: selecionar uma cidade no mapa preserva a posição vertical. Esses comportamentos são verificados por `scripts/verify-redesign.mjs` na raiz.

Validação dos formulários pertence à aplicação (`noValidate`). Login é validado no servidor e redireciona com mensagem de erro; envio vazio do chat é impedido por `send` e pelo botão desabilitado; logout não possui campos. A validação do navegador não substitui os controles do servidor.

Dados, login, logout, autorização e limites do chatbot mantêm os contratos de `docs/08-dashboard.md` na raiz do repositório. O cookie de tema é público e não representa uma sessão.
