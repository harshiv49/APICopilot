import * as vscode from "vscode";
import { ingestPostmanCollection } from "./load";
import * as path from "path";
import * as fs from "fs";
import { OpenAIEmbeddings } from "@langchain/openai";
import { ChatOpenAI } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { connect } from "@lancedb/lancedb";

// --- This class provides the "Refactor with API Docs" option in the lightbulb menu ---
class RefactorProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [
    vscode.CodeActionKind.Refactor,
  ];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range
  ): vscode.CodeAction[] | undefined {
    if (range.isEmpty) {
      return;
    }
    const refactorAction = new vscode.CodeAction(
      "Refactor with API Docs (CodePilot)",
      vscode.CodeActionKind.Refactor
    );
    refactorAction.command = {
      command: "codepilot.executeRefactor",
      title: "Refactor with API Docs",
      arguments: [document.getText(range)],
    };
    return [refactorAction];
  }
}
let autocompleteItems: vscode.CompletionItem[] = [];

// --- Helper functions ---
function toCamelCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .replace(/(?:^\w|[A-Z]|\b\w)/g, (word, index) =>
      index === 0 ? word.toLowerCase() : word.toUpperCase()
    )
    .replace(/\s+/g, "");
}

function getCodeCacheFilePath(
  context: vscode.ExtensionContext,
  endpointName: string,
  language: string
): string {
  const cacheDir = path.join(context.globalStorageUri.fsPath, "generated_code");
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const safeEndpointName = endpointName.replace(/[^a-zA-Z0-9]/g, "_");
  return path.join(cacheDir, `${safeEndpointName}_${language}.txt`);
}

function getCachedCode(
  context: vscode.ExtensionContext,
  endpointName: string,
  language: string
): string | null {
  const cacheFile = getCodeCacheFilePath(context, endpointName, language);
  if (fs.existsSync(cacheFile)) {
    return fs.readFileSync(cacheFile, "utf8");
  }
  return null;
}

function saveCodeToCache(
  context: vscode.ExtensionContext,
  endpointName: string,
  language: string,
  code: string
): void {
  const cacheFile = getCodeCacheFilePath(context, endpointName, language);
  fs.writeFileSync(cacheFile, code, "utf8");
}

// --- The "engine" for the autocomplete feature ---
async function generateCodeLogic(
  context: vscode.ExtensionContext,
  endpointName: string,
  collectionName: string,
  language: string
): Promise<string> {
  const cachedCode = getCachedCode(context, endpointName, language);
  if (cachedCode) {
    return cachedCode;
  }

  const config = vscode.workspace.getConfiguration("codepilot.openai");
  const apiKey = config.get<string>("apiKey");
  if (!apiKey) {
    throw new Error("OpenAI API Key is not set in settings.");
  }

  const userQuery = await vscode.window.showInputBox({
    prompt: `Generate ${language} code for "${endpointName}"`,
    placeHolder: 'e.g., "with error handling"',
  });
  if (userQuery === undefined) return "";

  const enrichedQuery = userQuery
    ? `${endpointName} ${userQuery}`
    : endpointName;

  const dbPath = path.join(context.globalStorageUri.fsPath, collectionName);
  const embeddings = new OpenAIEmbeddings({
    apiKey: apiKey,
    model: "text-embedding-3-small",
  });

  const db = await connect(dbPath);
  const table = await db.openTable(collectionName);
  const queryVector = await embeddings.embedQuery(enrichedQuery);
  const results = await table.search(queryVector).limit(4).toArray();

  const contextDocs = results.map((result: any) => ({
    pageContent: result.text,
    metadata: result.metadata,
  }));
  if (contextDocs.length === 0) {
    throw new Error(`Could not find documentation for '${endpointName}'.`);
  }
  const contextText = contextDocs.map((doc) => doc.pageContent).join("\n---\n");

  const llm = new ChatOpenAI({ model: "gpt-4o", apiKey: apiKey });
  const prompt = `Your task is to be a raw code generator. Based on the provided API documentation, generate a single, complete, and executable code snippet in ${language}. Your response will be directly executed as ${language} code. Do NOT include any explanations, introductory text, or markdown code blocks like \`\`\`. Real User Request: "${enrichedQuery}"\nGenerate the code now:`;

  const result = await llm.invoke(prompt);
  let codeSnippet = result.content.toString().trim();

  codeSnippet = codeSnippet
    .replace(/^```[\w]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  saveCodeToCache(context, endpointName, language, codeSnippet);
  return codeSnippet;
}

// --- The "engine" for the refactor feature ---
async function generateRefactoredCodeLogic(
  context: vscode.ExtensionContext,
  language: string,
  selectedText: string,
  userInstruction: string
): Promise<string> {
  const config = vscode.workspace.getConfiguration("codepilot.openai");
  const apiKey = config.get<string>("apiKey");
  if (!apiKey) {
    throw new Error("OpenAI API Key is not set.");
  }

  const storagePath = context.globalStorageUri.fsPath;
  const collectionDirs = fs
    .readdirSync(storagePath, { withFileTypes: true })
    .filter(
      (dirent) => dirent.isDirectory() && dirent.name.startsWith("codepilot_")
    )
    .map((dirent) => dirent.name);

  if (collectionDirs.length === 0) {
    throw new Error("No API documentation has been ingested yet.");
  }

  const collectionName = await vscode.window.showQuickPick(collectionDirs, {
    placeHolder: "Which API documentation should be used for context?",
  });
  if (!collectionName) return "";

  const dbPath = path.join(storagePath, collectionName);
  const embeddings = new OpenAIEmbeddings({
    apiKey: apiKey,
    model: "text-embedding-3-small",
  });
  const db = await connect(dbPath);
  const table = await db.openTable(collectionName);

  const searchQuery = `${userInstruction} ${selectedText}`;
  const queryVector = await embeddings.embedQuery(searchQuery);
  const results = await table.search(queryVector).limit(5).toArray();
  const apiContextText = results
    .map((result: any) => result.text)
    .join("\n---\n");

  const prompt = `You are an expert code refactoring assistant. Your task is to rewrite a given block of code to correctly and efficiently use an API, based on a user's instruction and the provided API documentation.
**Goal:** Your output will be a new, improved block of code that serves as a direct, drop-in replacement for the user's original selection.
**Context Provided:**
---
**API Documentation:**
${apiContextText}
---
**User's Original Code to Refactor:**
\`\`\`${language}
${selectedText}
\`\`\`
---
**User's Refactor Instruction:**
"${userInstruction}"
---
**Your Task:** Based on all the context above, generate the refactored code block in ${language}.
**Final Output Rules:**
- Return ONLY the refactored, executable code.
- Do not include any explanations, introductory text, or markdown formatting.
- The new code should be a complete, drop-in replacement for the original selection.
Generate the refactored code now:`;

  const llm = new ChatOpenAI({ model: "gpt-4o", apiKey: apiKey });
  const result = await llm.invoke(prompt);
  let refactoredCode = result.content.toString().trim();
  // Clean up markdown code block fences if the model includes them
  return refactoredCode
    .replace(/^```[\w]*\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  console.log("CodePilot is now active!");

  if (!fs.existsSync(context.globalStorageUri.fsPath)) {
    fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  }

  // --- COMMAND: Ingest Docs ---
  context.subscriptions.push(
    vscode.commands.registerCommand("codepilot.ingestDocs", async () => {
      const fileUri = await vscode.window.showOpenDialog({
        openLabel: "Select Postman Collection or OpenAPI Spec",
        filters: { "JSON Files": ["json"] },
      });
      if (!fileUri) return;

      const companyName = await vscode.window.showInputBox({
        prompt: "Enter the company name (e.g., 'Shiprocket')",
      });
      if (!companyName) return;

      const safeCompanyName = companyName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "_");
      const collectionName = `codepilot_${safeCompanyName}`;

      const config = vscode.workspace.getConfiguration("codepilot.openai");
      const apiKey = config.get<string>("apiKey");
      if (!apiKey) {
        vscode.window.showErrorMessage(
          "OpenAI API Key is not set in settings."
        );
        return;
      }

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `CodePilot: Ingesting '${companyName}' docs...`,
        },
        async () => {
          try {
            const storagePath = context.globalStorageUri.fsPath;
            const success = await ingestPostmanCollection(
              fileUri[0].fsPath,
              collectionName,
              companyName,
              apiKey,
              storagePath
            );

            if (success) {
              vscode.window.showInformationMessage(
                `✅ Successfully ingested '${companyName}' docs!`
              );
              await refreshAutocompleteItems(context);
            } else {
              throw new Error("Ingestion process failed.");
            }
          } catch (error: any) {
            vscode.window.showErrorMessage(
              `❌ Ingestion failed: ${error.message}`
            );
          }
        }
      );
    })
  );

  // --- COMMAND: Execute Refactor ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codepilot.executeRefactor",
      async (selectedText: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const userInstruction = await vscode.window.showInputBox({
          prompt:
            "How should I refactor this code using the API documentation?",
          placeHolder:
            "e.g., 'replace this mock data with a real API call to the createOrder endpoint'",
        });
        if (!userInstruction) return;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "CodePilot: Refactoring code...",
            cancellable: true,
          },
          async (progress, token) => {
            try {
              const newCode = await generateRefactoredCodeLogic(
                context,
                editor.document.languageId,
                selectedText,
                userInstruction
              );
              if (!newCode || token.isCancellationRequested) return;

              // Give user options on how to apply the new code
              const insertAction = await vscode.window.showQuickPick(
                [
                  "Replace Selection",
                  "Insert Above Selection",
                  "Insert Below Selection",
                ],
                { placeHolder: "How should the refactored code be applied?" }
              );

              if (!insertAction) return;

              editor.edit((editBuilder) => {
                const selection = editor.selection;
                if (insertAction === "Replace Selection")
                  editBuilder.replace(selection, newCode);
                else if (insertAction === "Insert Above Selection")
                  editBuilder.insert(selection.start, newCode + "\n\n");
                else if (insertAction === "Insert Below Selection")
                  editBuilder.insert(selection.end, "\n\n" + newCode);
              });
            } catch (error: any) {
              vscode.window.showErrorMessage(
                `Refactor failed: ${error.message}`
              );
            }
          }
        );
      }
    )
  );

  // --- COMMAND: Generate and Replace (for Autocomplete) ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codepilot.generateAndReplace",
      async (endpointName: string, collectionName: string) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const position = editor.selection.active;

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: `$(sync~spin) CodePilot: Generating code...`,
          },
          async () => {
            try {
              const language = editor.document.languageId;
              const codeSnippet = await generateCodeLogic(
                context,
                endpointName,
                collectionName,
                language
              );

              if (codeSnippet) {
                editor.edit((editBuilder) => {
                  const wordRange =
                    editor.document.getWordRangeAtPosition(position);
                  if (wordRange) {
                    editBuilder.replace(wordRange, codeSnippet);
                  } else {
                    editBuilder.insert(position, codeSnippet);
                  }
                });
              }
            } catch (error: any) {
              vscode.window.showErrorMessage(
                `Code generation failed: ${error.message}`
              );
            }
          }
        );
      }
    )
  );

  // --- COMMAND: Clear Individual Endpoint Cache ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "codepilot.clearEndpointCache",
      async () => {
        const cacheDir = path.join(
          context.globalStorageUri.fsPath,
          "generated_code"
        );
        if (!fs.existsSync(cacheDir) || fs.readdirSync(cacheDir).length === 0) {
          vscode.window.showInformationMessage("Code cache is empty.");
          return;
        }

        const cachedFiles = fs.readdirSync(cacheDir);
        const quickPickItems = cachedFiles.map((file) => {
          // Parse filename: endpointName_language.txt
          const nameWithoutExt = path.basename(file, ".txt");
          const lastUnderscoreIndex = nameWithoutExt.lastIndexOf("_");

          if (lastUnderscoreIndex === -1) {
            return {
              label: nameWithoutExt,
              description: file,
              endpointName: nameWithoutExt,
              language: "unknown",
            };
          }

          const endpointName = nameWithoutExt
            .substring(0, lastUnderscoreIndex)
            .replace(/_/g, " ");
          const language = nameWithoutExt.substring(lastUnderscoreIndex + 1);

          return {
            label: `${endpointName} (${language})`,
            description: file,
            endpointName: nameWithoutExt.substring(0, lastUnderscoreIndex),
            language,
          };
        });

        const selectedItem = await vscode.window.showQuickPick(quickPickItems, {
          placeHolder: "Select a cached endpoint to clear",
        });
        if (!selectedItem) return;

        const confirmation = await vscode.window.showWarningMessage(
          `Are you sure you want to delete the cache for "${selectedItem.label}"?`,
          { modal: true },
          "Yes, delete"
        );

        if (confirmation === "Yes, delete") {
          const filePath = path.join(cacheDir, selectedItem.description);
          try {
            fs.unlinkSync(filePath);
            vscode.window.showInformationMessage(
              `Cache for "${selectedItem.label}" has been cleared.`
            );
          } catch (error: any) {
            vscode.window.showErrorMessage(
              `Failed to clear cache: ${error.message}`
            );
          }
        }
      }
    )
  );

  // --- PROVIDER: Autocomplete ---
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      ["javascript", "python", "typescript", "go"],
      { provideCompletionItems: () => autocompleteItems },
      "."
    )
  );

  // --- PROVIDER: Refactor ---
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      ["javascript", "python", "typescript", "go"],
      new RefactorProvider(),
      { providedCodeActionKinds: RefactorProvider.providedCodeActionKinds }
    )
  );

  await refreshAutocompleteItems(context);
}

// --- Type definition for LanceDB records ---
type LanceDBRecord = { metadata: Document["metadata"] };

// --- Autocomplete Refresh function ---
async function refreshAutocompleteItems(
  context: vscode.ExtensionContext
): Promise<void> {
  const storagePath = context.globalStorageUri.fsPath;
  if (!fs.existsSync(storagePath)) return;

  const newItems: vscode.CompletionItem[] = [];
  const endpointNames = new Set<string>();

  const collectionDirs = fs
    .readdirSync(storagePath, { withFileTypes: true })
    .filter(
      (dirent) => dirent.isDirectory() && dirent.name !== "generated_code"
    )
    .map((dirent) => dirent.name);

  for (const collectionName of collectionDirs) {
    const dbPath = path.join(storagePath, collectionName);
    try {
      const db = await connect(dbPath);
      const table = await db.openTable(collectionName);

      for await (const batch of table.query().select(["metadata"])) {
        for (const recordProxy of batch) {
          const record = recordProxy.toJSON() as LanceDBRecord;
          const metadata = record.metadata;
          const originalEndpointName = metadata.name;

          if (
            originalEndpointName &&
            !endpointNames.has(originalEndpointName)
          ) {
            endpointNames.add(originalEndpointName);

            const camelCaseName = toCamelCase(originalEndpointName);
            const item = new vscode.CompletionItem(
              camelCaseName,
              vscode.CompletionItemKind.Function
            );
            item.detail = `from ${collectionName}`;
            item.documentation = new vscode.MarkdownString(
              `**${originalEndpointName}**\n\nGenerates a code snippet for this API call.`
            );

            item.insertText = new vscode.SnippetString(camelCaseName);

            item.command = {
              command: "codepilot.generateAndReplace",
              title: "CodePilot: Generate Code",
              arguments: [originalEndpointName, collectionName],
            };

            newItems.push(item);
          }
        }
      }
    } catch (error) {
      console.warn(
        `Could not refresh autocomplete from '${collectionName}':`,
        error
      );
    }
  }
  autocompleteItems = newItems;
  vscode.window.setStatusBarMessage(
    `CodePilot: ${autocompleteItems.length} API endpoints loaded.`,
    4000
  );
}
