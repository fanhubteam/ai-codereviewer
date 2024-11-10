import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { GoogleGenerativeAI } from '@google/generative-ai';
import * as https from 'https';
import * as http from 'http';

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const AI_PROVIDER: string = core.getInput("AI_PROVIDER").toLowerCase();
const API_KEY: string = core.getInput("API_KEY");
const MODEL: string = core.getInput("MODEL");
const AVALIAR_TEST_PR: boolean = core.getInput("AVALIAR_TEST_PR").toLowerCase() === "true";
const WEBHOOK_URL: string = core.getInput("WEBHOOK_URL");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// Modificar a inicialização do OpenAI para ser condicional
const openai = API_KEY ? new OpenAI({ apiKey: API_KEY }) : null;

const TEST_PATTERNS = [
  // Padrões genéricos de teste
  "**/test/**",
  "**/tests/**",
  "**/*test*",
  "**/*Test*",
  "**/*spec*",
  "**/*Spec*",
  // Python/Django
  "**/test_*.py",
  "**/*_test.py",
  "**/tests.py",
  "**/conftest.py",
  // JavaScript/TypeScript
  "**/*.test.ts",
  "**/*.test.js",
  "**/*.spec.ts",
  "**/*.spec.js",
  // Outros padrões comuns
  "**/__tests__/**",
  "**/testing/**",
  "**/pytest/**",
  "**/unittest/**"
];

const EXEMPTION_KEYWORDS = [
  'no tests needed',
  'test exempt',
  'skip tests',
  'sem necessidade de teste',
  'não requer teste'
];

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
  author: {
    login: string;
    name: string;
  };
}

interface TestAnalysisResult {
  hasTests: boolean;
  missingTests: string[];
  affectedFiles: string[];
}

// Adicionar logs iniciais de configuração
console.log('=== Configuration Debug ===');
console.log('AI_PROVIDER:', AI_PROVIDER);
console.log('Has API_KEY:', !!API_KEY);
console.log('AVALIAR_TEST_PR:', AVALIAR_TEST_PR);
console.log('========================');

async function getPRDetails(): Promise<PRDetails> {
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );

  // Determina o número da PR e o repositório com base no tipo de evento
  const owner = eventData.repository.owner.login;
  const repo = eventData.repository.name;
  let pullNumber: number;

  // Adiciona suporte para obter informações do autor da PR
  let prAuthor = {
    login: '',
    name: ''
  };

  if (eventData.issue?.pull_request) {
    pullNumber = eventData.issue.number;
    prAuthor.login = eventData.issue.user.login;
  } else if (eventData.pull_request) {
    pullNumber = eventData.pull_request.number;
    prAuthor.login = eventData.pull_request.user.login;
  } else {
    throw new Error('Could not determine pull request number');
  }

  const prResponse = await octokit.pulls.get({
    owner,
    repo,
    pull_number: pullNumber,
  });

  // Busca informações detalhadas do usuário
  const userResponse = await octokit.users.getByUsername({
    username: prAuthor.login
  });
  prAuthor.name = userResponse.data.name || prAuthor.login;

  return {
    owner,
    repo,
    pull_number: pullNumber,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
    author: prAuthor // Adiciona informações do autor
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<Array<{ body: string; path: string; line: number }>> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments) {
          comments.push(...newComments);
        }
      }
    }
  }
  return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- Responda em português.

Review the following code diff in the file "${file.to}" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

interface AIProvider {
  getResponse(prompt: string): Promise<Array<{
    lineNumber: string;
    reviewComment: string;
  }> | null>;
  processReason(prompt: string, jsonResponse?: boolean): Promise<string>;
}

class OpenAIProvider implements AIProvider {
  private openai: OpenAI;

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey });
  }

  async getResponse(prompt: string) {
    const queryConfig = {
      model: MODEL,
      temperature: 0.2,
      max_tokens: 700,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    };

    try {
      const response = await this.openai.chat.completions.create({
        ...queryConfig,
        ...(MODEL === "gpt-4-1106-preview"
          ? { response_format: { type: "json_object" } }
          : {}),
        messages: [{ role: "system", content: prompt }],
      });

      const res = response.choices[0].message?.content?.trim() || "{}";
      return JSON.parse(res).reviews;
    } catch (error) {
      console.error("OpenAI Error:", error);
      return null;
    }
  }

  // Modify the processReason method
  async processReason(prompt: string, jsonResponse: boolean = false): Promise<string> {
    const completion = await this.openai.chat.completions.create({
      model: MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: jsonResponse ? 
            "You are a code review assistant that always responds in valid JSON format." : 
            "You are a code review assistant."
        },
        { 
          role: "user", 
          content: prompt 
        }
      ],
      // Conditionally include response_format
      ...(jsonResponse && MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {})
    });

    const content = completion.choices[0].message?.content;
    if (!content) {
      throw new Error('OpenAI returned empty response');
    }

    return content;
  }
}

class GeminiProvider implements AIProvider {
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async getResponse(prompt: string) {
    try {
      const model = this.genAI.getGenerativeModel({ 
        model: MODEL,
        generationConfig: {
          temperature: 0.2,
          topP: 1,
          topK: 1,
        }
      });

      // Força o formato JSON através do prompt
      const jsonPrompt = `${prompt}

IMPORTANT INSTRUCTIONS:
1. You must respond ONLY with a valid JSON object
2. The JSON must follow exactly this structure:
{
  "reviews": [
    {
      "lineNumber": "string with line number",
      "reviewComment": "string with review comment"
    }
  ]
}
3. DO NOT include any explanations or additional text
4. If there are no comments, respond with {"reviews": []}
5. Make sure the output is parseable JSON

Response:`;

      const result = await model.generateContent(jsonPrompt);
      const response = result.response;
      const text = response.text();
      
      // Tenta encontrar JSON válido na resposta
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('No valid JSON found in response');
        return null;
      }

      // Parse e valida o JSON
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.reviews)) {
        console.error('Invalid JSON structure');
        return null;
      }

      return parsed.reviews;
    } catch (error) {
      console.error("Gemini Error:", error);
      return null;
    }
  }

  // Adicionar método para processar prompts de razão
  async processReason(prompt: string, jsonResponse: boolean = false): Promise<string> {
    const model = this.genAI.getGenerativeModel({ 
      model: MODEL,
      generationConfig: {
        temperature: 0.1,
        topP: 1,
        topK: 1,
      }
    });

    if (jsonResponse) {
      prompt = `${prompt}\n\nIMPORTANT: You must respond ONLY with a valid JSON object. No additional text.`;
    }

    const result = await model.generateContent(prompt);
    const response = result.response.text();

    if (jsonResponse) {
      // Extract JSON from response for Gemini
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in Gemini response');
      }
      return jsonMatch[0];
    }

    return response;
  }
}

// Centralizar a lógica de seleção do provedor de IA
function getAIProvider(): AIProvider {
  if (!API_KEY) {
    throw new Error('API_KEY is required');
  }

  if (AI_PROVIDER === 'gemini') {
    return new GeminiProvider(API_KEY);
  } else {
    return new OpenAIProvider(API_KEY);
  }
}

// Modificar a função getAIResponse com mais logs
async function getAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {
  console.log('\n=== getAIResponse Debug ===');
  console.log('Selecting AI provider:', AI_PROVIDER);
  
  try {
    const provider = getAIProvider();
    console.log(`${AI_PROVIDER.charAt(0).toUpperCase() + AI_PROVIDER.slice(1)} provider initialized successfully`);
    const response = await provider.processReason(prompt, true);
    const reviews = JSON.parse(response).reviews;
    return reviews;
  } catch (error) {
    console.error('Error in getAIResponse:', error);
    throw error;
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

// Modificar a função createReviewComment para aceitar um body opcional
async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>,
  event: "COMMENT" | "APPROVE" = "COMMENT",  // Adiciona opção de evento
  body?: string  // Adiciona parâmetro body opcional
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event,
    ...(body ? { body } : {})
  });
}

function needsTests(file: File): boolean {
  const filename = file.to || '';
  
  // Ignora arquivos excluídos e arquivos que são testes
  if (TEST_PATTERNS.some(pattern => minimatch(filename, pattern))) {
    return false;
  }

  // Lista de extensões de arquivos que geralmente precisam de testes
  const testableExtensions = [
    '.py',    // Python
    '.js',    // JavaScript
    '.ts',    // TypeScript
    '.jsx',   // React
    '.tsx',   // React com TypeScript
    '.vue',   // Vue
    '.rb',    // Ruby
    '.php',   // PHP
    '.java',  // Java
    '.go',    // Go
    '.cs',    // C#
    '.cpp',   // C++
    '.rs'     // Rust
  ];

  // Ignora arquivos de configuração e tipos
  const excludePatterns = [
    '.config.',
    '.conf.',
    '.d.ts',
    'settings.py',
    'urls.py',
    'wsgi.py',
    'asgi.py',
    'manage.py'
  ];

  const ext = filename.slice(filename.lastIndexOf('.'));
  return testableExtensions.includes(ext) && 
         !excludePatterns.some(pattern => filename.includes(pattern));
}

async function analyzeTests(parsedDiff: File[], prDetails: PRDetails): Promise<TestAnalysisResult> {
  const affectedFiles = parsedDiff
    .filter(file => file.to && needsTests(file))
    .map(file => file.to!) || [];

  const testFiles = parsedDiff
    .filter(file => file.to && (
      // Verifica se o arquivo está em um diretório de testes
      TEST_PATTERNS.some(pattern => minimatch(file.to!, pattern)) ||
      // Verifica se o arquivo contém 'test' no nome (case insensitive)
      file.to.toLowerCase().includes('test')
    ))
    .map(file => file.to!);

  const missingTests = affectedFiles.filter(file => {
    const baseNameWithoutExt = file.replace(/\.[^/.]+$/, '');
    const possibleTestPatterns = [
      // Padrões genéricos
      `${baseNameWithoutExt}_test`,
      `test_${baseNameWithoutExt}`,
      `${baseNameWithoutExt}.test`,
      `${baseNameWithoutExt}.spec`,
      // Considera diferentes diretórios de teste
      baseNameWithoutExt.replace(/src\//, 'test/'),
      baseNameWithoutExt.replace(/src\//, 'tests/'),
      baseNameWithoutExt.replace(/app\//, 'tests/'),
      // Django specific
      baseNameWithoutExt.replace(/views\.py$/, 'tests.py'),
      baseNameWithoutExt.replace(/models\.py$/, 'tests.py')
    ];

    return !testFiles.some(testFile => 
      possibleTestPatterns.some(pattern => 
        testFile.toLowerCase().includes(pattern.toLowerCase())
      )
    );
  });

  return {
    hasTests: testFiles.length > 0,
    missingTests,
    affectedFiles
  };
}

function hasTestExemption(description: string): boolean {
  return EXEMPTION_KEYWORDS.some(keyword => 
    description.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Add new function for webhook
async function sendWebhook(data: any): Promise<void> {
  if (!WEBHOOK_URL) return;

  return new Promise((resolve, reject) => {
    const url = new URL(WEBHOOK_URL);
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      }
    };

    const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
      res.on('end', () => resolve());
    });

    req.on('error', (error) => {
      console.error('Webhook Error:', error);
      reject(error);
    });

    req.write(JSON.stringify(data));
    req.end();
  });
}

// Adicionar função para verificar se é um comando válido
function isCodeReviewCommand(comment: string): boolean {
  return comment.trim().startsWith('/code_review');
}

// Add new interface for LLM response structure
interface TestExemptionResponse {
  isValidJustification: boolean;
  justification: string;
  analysis: string;
  recommendation: string;
}

// Add new utility function to validate JSON structure
function isValidExemptionResponse(data: any): data is TestExemptionResponse {
  return typeof data === 'object' && data !== null &&
         typeof data.isValidJustification === 'boolean' &&
         typeof data.justification === 'string' &&
         typeof data.analysis === 'string' &&
         typeof data.recommendation === 'string';
}

// Add retry function for LLM calls
async function retryLLMWithError(
  provider: AIProvider, 
  originalPrompt: string, 
  errorDetails: string,
  maxRetries: number = 2
): Promise<string> {
  const retryPrompt = `Ocorreu um erro ao processar a resposta anterior. Por favor, corrija e gere uma nova resposta.

Erro encontrado: ${errorDetails}

IMPORTANTE:
1. Você DEVE retornar um objeto JSON válido
2. O JSON deve seguir EXATAMENTE esta estrutura:
{
  "isValidJustification": boolean,
  "justification": "string",
  "analysis": "string",
  "recommendation": "string"
}
3. Não inclua nenhum texto adicional antes ou depois do JSON
4. Certifique-se que todos os campos estejam presentes

Prompt original:
${originalPrompt}

Response:`;

  return provider.processReason(retryPrompt, true);
}

// Modify extractTestExemptionReason to include retry logic
async function extractTestExemptionReason(description: string): Promise<string | null> {
  const prompt = `Analise o texto abaixo e extraia a justificativa para a isenção de testes.
Se encontrar uma justificativa, avalie sua validade e formate uma resposta detalhada.

Texto da PR:
---
${description}
---

Requisitos:
1. Identifique especificamente o trecho que justifica a isenção de testes
2. Avalie se a justificativa é válida
3. Explique por que a justificativa é ou não aceitável

Retorne no seguinte formato JSON (importante: mantenha a estrutura exata):
{
  "isValidJustification": true/false,
  "justification": "texto extraído que justifica a isenção",
  "analysis": "sua análise da justificativa",
  "recommendation": "recomendação final"
}`;

  try {
    const provider = getAIProvider();
    console.log('Requesting test exemption analysis from LLM...');
    
    let response = await provider.processReason(prompt, true);
    console.log('Initial LLM response:', response);

    let parsed: TestExemptionResponse | null = null;
    let retryCount = 0;
    const maxRetries = 2;

    while (retryCount < maxRetries) {
      try {
        const parsedAttempt = JSON.parse(response);
        
        if (isValidExemptionResponse(parsedAttempt)) {
          parsed = parsedAttempt;
          break;
        }

        console.log(`Attempt ${retryCount + 1}: Invalid response structure`);
        response = await retryLLMWithError(
          provider,
          prompt,
          'A resposta não seguiu a estrutura JSON esperada. Todos os campos são obrigatórios.',
          maxRetries
        );
        retryCount++;
        
      } catch (e) {
        console.log(`Attempt ${retryCount + 1}: JSON parse error`);
        response = await retryLLMWithError(
          provider,
          prompt,
          'A resposta não é um JSON válido. Por favor, corrija a sintaxe.',
          maxRetries
        );
        retryCount++;
      }
    }

    if (!parsed) {
      console.error('Failed to get valid response after retries');
      return "⚠️ Não foi possível analisar a justificativa após múltiplas tentativas. Por favor, revise e tente novamente.";
    }

    if (!parsed.isValidJustification) {
      return "⚠️ Uma justificativa válida para isenção de testes não foi encontrada. Por favor, explique claramente por que os testes não são necessários.";
    }

    return `📝 **Análise da Justificativa para Isenção de Testes**

> ${parsed.justification}

**Análise**: ${parsed.analysis}

**Recomendação**: ${parsed.recommendation}`;

  } catch (error) {
    console.error('Error in extractTestExemptionReason:', error);
    return null;
  }
}

// Ajustar a função getTestExemptionDetails para usar a mensagem detalhada
async function getTestExemptionDetails(description: string): Promise<{ isExempt: boolean; reason: string }> {
  const isExempt = hasTestExemption(description);

  if (!isExempt) {
    return { isExempt: false, reason: '' };
  }

  const detailedReason = await extractTestExemptionReason(description);

  return { 
    isExempt: true, 
    reason: detailedReason || 'Isenção de testes solicitada, mas nenhuma justificativa detalhada foi fornecida.'
  };
}

// Modificar o main para incluir verificação de comentários
async function main() {
  try {
    console.log('\n=== Starting main execution ===');
    console.log('Event path:', process.env.GITHUB_EVENT_PATH);
    
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );
    
    console.log('Event type:', eventData.action);
    
    // Verificar se é um comentário em PR com comando /code_review
    let shouldProcessPR = false;
    if (eventData.comment) {
      if (!eventData.issue?.pull_request) {
        console.log('Comment is not on a pull request, ignoring');
        return;
      }

      if (!isCodeReviewCommand(eventData.comment.body)) {
        console.log('Comment is not a code review command, ignoring');
        return;
      }

      console.log('Code review command detected');
      shouldProcessPR = true;
    } else if (eventData.pull_request && 
              ["opened", "reopened", "synchronize"].includes(eventData.action)) {
      shouldProcessPR = true;
    }

    if (!shouldProcessPR) {
      console.log('No valid trigger for PR processing');
      return;
    }

    const prDetails = await getPRDetails();
    console.log('PR Details retrieved:', {
      owner: prDetails.owner,
      repo: prDetails.repo,
      pull_number: prDetails.pull_number
    });

    let diff: string | null = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);

    if (!diff) {
      console.log('No diff found');
      return;
    }

    console.log('Diff found, proceeding with analysis');
    const parsedDiff = parseDiff(diff);
    console.log('Number of files in diff:', parsedDiff.length);

    const testAnalysis = await analyzeTests(parsedDiff, prDetails);
    console.log('Test Analysis Result:', {
      hasTests: testAnalysis.hasTests,
      numberOfAffectedFiles: testAnalysis.affectedFiles.length,
      numberOfMissingTests: testAnalysis.missingTests.length
    });

    let hasIssues = false;

    const testExemptionDetails = await getTestExemptionDetails(prDetails.description);

    // Verifica se existem arquivos que precisam de teste
    if (testAnalysis.affectedFiles.length > 0 && !testAnalysis.hasTests && !testExemptionDetails.isExempt) {
      hasIssues = true;
      const testWarning = `⚠️ Verificação de Testes

Esta PR contém alterações em arquivos que requerem testes, mas nenhum teste foi encontrado.

Arquivos que precisam de testes:
${testAnalysis.missingTests.map(file => `- \`${file}\``).join('\n')}

Por favor:
1. Adicione testes apropriados para as alterações realizadas, ou
2. Inclua uma justificativa no corpo da PR caso os testes não sejam necessários.

Use uma das seguintes palavras-chave na descrição da PR para indicar que não são necessários testes:
- "sem necessidade de teste"
- "não requer teste"
- "skip tests"
- "test exempt"
- "no tests needed"`;

      await octokit.issues.createComment({
        owner: prDetails.owner,
        repo: prDetails.repo,
        issue_number: prDetails.pull_number,
        body: testWarning
      });
      
      // Enviar webhook se URL estiver configurada
      if (WEBHOOK_URL) {
        try {
          await sendWebhook({
            // Informações do repositório
            repository: {
              full_name: `${prDetails.owner}/${prDetails.repo}`,
              name: prDetails.repo,
              owner: prDetails.owner,
              url: `https://github.com/${prDetails.owner}/${prDetails.repo}`
            },
            // Informações da PR
            pull_request: {
              number: prDetails.pull_number,
              title: prDetails.title,
              description: prDetails.description,
              url: `https://github.com/${prDetails.owner}/${prDetails.repo}/pull/${prDetails.pull_number}`,
              author: {
                login: prDetails.author.login,
                name: prDetails.author.name,
                profile_url: `https://github.com/${prDetails.author.login}`
              },
              created_at: eventData.pull_request?.created_at,
              updated_at: eventData.pull_request?.updated_at,
              state: eventData.pull_request?.state,
              draft: eventData.pull_request?.draft || false,
              labels: eventData.pull_request?.labels || []
            },
            // Informações da análise
            analysis: {
              missing_tests: testAnalysis.missingTests,
              affected_files: testAnalysis.affectedFiles,
              has_tests: testAnalysis.hasTests,
              total_files_analyzed: parsedDiff.length,
              test_exemption: {
                is_exempt: testExemptionDetails.isExempt,
                reason: testExemptionDetails.reason,
                detected_keyword: testExemptionDetails.isExempt ? true : false
              },
              needs_tests: testAnalysis.affectedFiles.length > 0 && !testAnalysis.hasTests
            },
            // Metadados
            metadata: {
              timestamp: new Date().toISOString(),
              action: eventData.action,
              triggered_by: eventData.sender?.login,
              event_type: eventData.comment ? 'comment_command' : 'pr_event'
            }
          });
          console.log('Webhook sent successfully with test exemption information');
        } catch (error) {
          console.error('Failed to send webhook:', error);
        }
      }

      // Se AVALIAR_TEST_PR for true, encerra aqui
      if (AVALIAR_TEST_PR) {
        return;
      }
    }

    // Continua com a análise normal do código apenas se AVALIAR_TEST_PR for false
    if (!AVALIAR_TEST_PR) {
      const excludePatterns = core.getInput("exclude").split(",").map(s => s.trim());
      const filteredDiff = parsedDiff.filter(file => 
        !excludePatterns.some(pattern => minimatch(file.to ?? "", pattern))
      );

      const comments = await analyzeCode(filteredDiff, prDetails);
      if (comments.length > 0) {
        hasIssues = true;
        await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
      }
    }

    // Adiciona aprovação se não houver problemas
    if (!hasIssues) {
      let approvalBody: string;

      if (testAnalysis.affectedFiles.length > 0 && !testAnalysis.hasTests && testExemptionDetails.isExempt) {
        // Aprovação com exceção e mensagem detalhada
        approvalBody = `✨ **LGTM** - Aprovado com exceção de testes

${testExemptionDetails.reason}

---
*Esta PR foi aprovada com isenção de testes baseada na justificativa acima.*`;
      } else {
        approvalBody = "✨ **LGTM** - Looks Good To Me!\n\nCódigo revisado e aprovado. Não foram encontrados problemas significativos.";
      }

      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        [], // sem comentários específicos
        "APPROVE", // aprova a PR
        approvalBody // passa a mensagem de aprovação
      );
    }

  } catch (error) {
    console.error('Main execution error:', error);
    throw error;
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
