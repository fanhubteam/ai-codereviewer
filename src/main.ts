import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { GoogleGenerativeAI } from '@google/generative-ai';

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const AI_PROVIDER: string = core.getInput("AI_PROVIDER").toLowerCase();
const API_KEY: string = core.getInput("API_KEY");
const MODEL: string = core.getInput("MODEL");
const AVALIAR_TEST_PR: boolean = core.getInput("AVALIAR_TEST_PR").toLowerCase() === "true";

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

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
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
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
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

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
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
          // Força o modelo a gerar apenas JSON
          structuredOutput: true,
          // Define o schema esperado
          schema: {
            type: "object",
            properties: {
              reviews: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    lineNumber: { type: "string" },
                    reviewComment: { type: "string" }
                  },
                  required: ["lineNumber", "reviewComment"]
                }
              }
            },
            required: ["reviews"]
          }
        }
      });

      // Adiciona instruções específicas para forçar JSON
      const promptWithJson = `${prompt}\nIMPORTANT: You must respond only with valid JSON matching this exact schema:\n{
        "reviews": [
          {
            "lineNumber": "string",
            "reviewComment": "string"
          }
        ]
      }`;

      const result = await model.generateContent(promptWithJson);
      const response = result.response;
      const text = response.text();
      return JSON.parse(text).reviews;
    } catch (error) {
      console.error("Gemini Error:", error);
      return null;
    }
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
    if (!API_KEY) {
      throw new Error('API_KEY is required');
    }

    if (AI_PROVIDER === 'gemini') {
      const provider = new GeminiProvider(API_KEY);
      console.log('Gemini provider initialized successfully');
      return provider.getResponse(prompt);
    } else {
      const provider = new OpenAIProvider(API_KEY);
      console.log('OpenAI provider initialized successfully');
      return provider.getResponse(prompt);
    }
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

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    comments,
    event: "COMMENT",
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
  const exemptionKeywords = [
    'no tests needed',
    'test exempt',
    'skip tests',
    'sem necessidade de teste',
    'não requer teste'
  ];
  
  return exemptionKeywords.some(keyword => 
    description.toLowerCase().includes(keyword.toLowerCase())
  );
}

// Modificar o main para incluir mais logs
async function main() {
  try {
    console.log('\n=== Starting main execution ===');
    const prDetails = await getPRDetails();
    console.log('PR Details retrieved:', {
      owner: prDetails.owner,
      repo: prDetails.repo,
      pull_number: prDetails.pull_number
    });

    let diff: string | null;
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
    );

    if (eventData.action === "opened" || eventData.action === "reopened" || eventData.action === "synchronize") {
      if (eventData.action === "synchronize") {
        const response = await octokit.repos.compareCommits({
          headers: { accept: "application/vnd.github.v3.diff" },
          owner: prDetails.owner,
          repo: prDetails.repo,
          base: eventData.before,
          head: eventData.after,
        });
        diff = String(response.data);
      } else {
        diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
      }

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

      // Verifica se existem arquivos que precisam de teste
      if (testAnalysis.affectedFiles.length > 0 && !testAnalysis.hasTests && !hasTestExemption(prDetails.description)) {
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
          await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
        }
      }
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
