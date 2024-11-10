# Revisor de Código com IA

O Revisor de Código com IA é uma GitHub Action que utiliza provedores de IA (OpenAI ou Gemini) para fornecer feedback inteligente e sugestões sobre suas pull requests. Essa ferramenta ajuda a melhorar a qualidade do código e economiza tempo dos desenvolvedores ao automatizar o processo de revisão de código.

## Funcionalidades

- Revisa pull requests usando o modelos da OpenAI ou Gemini do Google
- Fornece comentários inteligentes e sugestões para melhorar seu código
- Verificação automática de cobertura de testes
- Filtra arquivos que correspondem a padrões de exclusão especificados
- Fácil de configurar e integrar ao seu fluxo de trabalho no GitHub

## Configuração

1. Você precisará de uma chave de API da OpenAI ou do Google (Gemini). Inscreva-se para obter uma chave de API em:
   - OpenAI: [Plataforma OpenAI](https://platform.openai.com/signup)
   - Google AI: [Google AI Studio](https://makersuite.google.com/app/apikey)

2. Adicione a chave de API escolhida como um segredo no seu repositório GitHub com um nome apropriado (por exemplo, `OPENAI_API_KEY` ou `GOOGLE_API_KEY`).

3. Crie um arquivo `.github/workflows/code_review.yml` no seu repositório e adicione o seguinte conteúdo:

```yaml
name: Code Review with LLM

on:
  pull_request:
    types:
      - opened
      - synchronize
      - reopened
  issue_comment:
    types:
      - created
permissions:
  contents: read
  pull-requests: write
  issues: write
jobs:
  code_review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3
        with:
          fetch-depth: 0
          ref: ${{ github.event.pull_request.head.sha }}
      - name: Code Review
        uses: fanhubteam/ai-codereviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AI_PROVIDER: "gemini"
          API_KEY: ${{ secrets.GOOGLE_API_KEY }}
          MODEL: "gemini-1.5-flash-latest"
          exclude: "yarn.lock,dist/**"
          AVALIAR_TEST_PR: "true"
          WEBHOOK_URL: ${{ secrets.WEBHOOK_URL }}
```

4. Substitua `fanhubteam` pelo seu nome de usuário ou nome da organização no GitHub onde o repositório do Revisor de Código com IA está localizado.

5. Personalize a entrada `exclude` se você quiser ignorar certos padrões de arquivos na revisão.

6. Comite as mudanças no seu repositório, e o Revisor de Código com IA começará a funcionar nas suas futuras pull requests.

### Notificações via Webhook

Você pode configurar uma URL de webhook para receber notificações quando os testes estiverem faltando:

## Como Funciona

A GitHub Action do Revisor de Código com IA é acionada em três momentos principais:

1. **Automaticamente em Pull Requests**:
   - Quando uma PR é aberta
   - Quando novos commits são adicionados (synchronize)
   - Quando uma PR é reaberta

2. **Manualmente via Comando**:
   - Quando alguém comenta `/code_review` em uma PR existente

Para cada acionamento, a action executa os seguintes passos:

1. **Análise do Código**:
   - Recupera o diff completo da pull request
   - Filtra arquivos excluídos baseado nos padrões definidos em `exclude`
   - Identifica alterações específicas por arquivo

2. **Verificação de Testes**:
   - Analisa se existem testes para as alterações realizadas
   - Verifica padrões comuns de arquivos de teste (.test.js, .spec.ts, etc)
   - Se `AVALIAR_TEST_PR` estiver ativo, alerta sobre arquivos sem testes

3. **Revisão por IA**:
   - Envia o código alterado para o provedor de IA configurado (OpenAI ou Gemini)
   - Processa a resposta da IA para gerar comentários relevantes
   - Adiciona os comentários diretamente na linha específica do código

4. **Notificações**:
   - Se configurado, envia notificações via webhook sobre testes faltantes
   - Adiciona todos os comentários como uma única revisão na PR
   - Marca problemas encontrados para correção

A action utiliza o contexto completo da PR, incluindo título e descrição, para fornecer revisões mais precisas e contextualizadas. Todos os comentários são feitos em português e focam em sugestões de melhorias, sem incluir elogios ou comentários positivos desnecessários.

## Usando o Comando `/code_review`

Você pode usar o comando `/code_review` em comentários de pull requests para acionar manualmente a revisão de código pela IA. Basta adicionar um comentário na pull request com o texto `/code_review` e a ação será executada.

## Contribuindo

Contribuições são bem-vindas! Sinta-se à vontade para enviar issues ou pull requests para melhorar a GitHub Action do Revisor de Código com IA.

Deixe o mantenedor gerar o pacote final (`yarn build` & `yarn package`).

## Licença

Este projeto é licenciado sob a Licença MIT. Veja o arquivo [LICENSE](LICENSE) para mais informações.
