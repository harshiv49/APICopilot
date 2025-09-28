import * as fs from "fs";
import * as path from "path";
import { Document } from "@langchain/core/documents";
import { ChatOpenAI } from "@langchain/openai";
import { connect } from "@lancedb/lancedb";
import { OpenAIEmbeddings } from "@langchain/openai";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import dotenv from "dotenv";

export class IngestionTool {
  private llm: ChatOpenAI;
  private embeddings: OpenAIEmbeddings;
  private textSplitter: RecursiveCharacterTextSplitter;

  constructor(openaiApiKey: string) {
    if (!openaiApiKey) {
      throw new Error("OpenAI API key is required.");
    }
    this.llm = new ChatOpenAI({
      model: "gpt-3.5-turbo",
      temperature: 0,
      apiKey: openaiApiKey,
    });
    this.textSplitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    console.log("Using OpenAI embeddings");
    this.embeddings = new OpenAIEmbeddings({
      apiKey: openaiApiKey,
      model: "text-embedding-3-small",
      batchSize: 20,
    });
  }

  public async run(
    postmanPath: string,
    collectionName: string,
    company: string,
    storagePath: string
  ): Promise<boolean> {
    const dbPath = path.join(storagePath, collectionName);

    if (fs.existsSync(dbPath)) {
      console.log(`✅ LanceDB store for '${collectionName}' already exists.`);
      console.log(
        "Skipping ingestion to save on API costs. Delete the folder to re-ingest."
      );
      return true;
    }

    try {
      console.log(">>> Step 1: Loading Postman JSON file...");
      const rawText = fs.readFileSync(postmanPath, "utf-8");
      const postmanData = JSON.parse(rawText);

      console.log(">>> Step 2: Flattening endpoints...");
      const endpoints = this.flattenEndpoints(postmanData.item || []);
      console.log(`-> Found ${endpoints.length} total endpoints.`);

      console.log(">>> Step 3: Creating documents from endpoints...");
      let documents = await this.createDocumentsFromEndpoints(
        endpoints,
        company
      );
      console.log(`-> Created ${documents.length} initial documents.`);

      console.log(">>> Step 4: Splitting large documents...");
      const chunks = await this.textSplitter.splitDocuments(documents);
      console.log(`-> Split into ${chunks.length} total chunks for embedding.`);

      console.log(
        ">>> Step 5: Creating embeddings and saving LanceDB store..."
      );
      await this.createAndSaveLanceDBStore(chunks, collectionName, storagePath);
      return true;
    } catch (error) {
      console.error("Ingestion pipeline failed:", error);
      return false;
    }
  }

  private flattenEndpoints(items: any[]): any[] {
    const out: any[] = [];
    for (const item of items) {
      if (item.item && Array.isArray(item.item)) {
        out.push(...this.flattenEndpoints(item.item));
      } else {
        out.push(item);
      }
    }
    return out;
  }

  private constructUrlFromPostman(urlData: any): string {
    if (!urlData) {
      return "";
    }
    if (typeof urlData === "string") {
      return urlData;
    }
    if (typeof urlData === "object" && urlData !== null) {
      if (urlData.raw) {
        return urlData.raw;
      }
      const protocol = urlData.protocol || "https";
      const host = (urlData.host || []).join(".");
      const path = (urlData.path || []).join("/");
      if (host) {
        return `${protocol}://${host}/${path}`;
      }
    }
    return "";
  }

  private async createDocumentsFromEndpoints(
    endpoints: any[],
    company: string
  ): Promise<Document[]> {
    const documents: Document[] = [];
    for (const ep of endpoints) {
      const name = ep.name?.trim() || "";
      const url = this.constructUrlFromPostman(ep.request?.url);
      const baseMeta = {
        name,
        company,
        method: ep.request?.method?.toUpperCase() || "",
        url: url,
      };

      if (ep.request?.description) {
        const descriptionText =
          typeof ep.request.description === "string"
            ? ep.request.description
            : ep.request.description?.content || "";

        const contentWithUrl = `Endpoint URL: ${url}\n\n${descriptionText}`;
        const enhancedDesc = await this.enhanceDescription(
          contentWithUrl,
          name,
          company
        );
        documents.push(
          new Document({
            pageContent: enhancedDesc,
            metadata: { ...baseMeta, type: "description" },
          })
        );
      }
      if (ep.request?.body?.raw) {
        documents.push(
          new Document({
            pageContent: ep.request.body.raw,
            metadata: { ...baseMeta, type: "body" },
          })
        );
      }
      for (const res of ep.response || []) {
        if (res.body) {
          documents.push(
            new Document({
              pageContent: res.body,
              metadata: {
                ...baseMeta,
                type: "response",
                status_code: res.code,
              },
            })
          );
        }
      }
    }
    return documents;
  }

  private async enhanceDescription(
    desc: string,
    name: string,
    company: string
  ): Promise<string> {
    const prompt = `API Company: ${company}\nEndpoint: ${name}\nOriginal Description: ${desc}\n\nPlease add a single concise sentence explaining a few key business use cases.`;
    try {
      const response = await this.llm.invoke(prompt);
      return response.content.toString().trim();
    } catch (error) {
      console.warn(`Failed to enhance description for '${name}': ${error}`);
      return desc;
    }
  }

  private async createAndSaveLanceDBStore(
    chunks: Document[],
    collectionName: string,
    storagePath: string
  ): Promise<void> {
    const dbPath = path.join(storagePath, collectionName);
    console.log(`-> Using database path: ${dbPath}`);

    if (fs.existsSync(dbPath)) {
      console.log(`-> Existing index found. Overwriting...`);
      fs.rmSync(dbPath, { recursive: true, force: true });
    }

    if (chunks.length === 0) {
      console.log("-> No chunks to process. Skipping store creation.");
      return;
    }

    console.log(`-> Creating embeddings for ${chunks.length} chunks...`);
    const texts = chunks.map((chunk) => chunk.pageContent);
    const vectors = await this.embeddings.embedDocuments(texts);

    const data = chunks.map((chunk, i) => ({
      text: chunk.pageContent,
      metadata: chunk.metadata,
      vector: vectors[i],
    }));

    console.log("-> Connecting to LanceDB and creating table...");
    const db = await connect(dbPath);
    await db.createTable(collectionName, data);

    console.log(
      `-> Successfully saved LanceDB index with ${chunks.length} chunks.`
    );
  }
}

export async function ingestPostmanCollection(
  postmanPath: string,
  collectionName: string,
  companyName: string,
  openaiApiKey: string,
  storagePath: string
): Promise<boolean> {
  console.log("--- Starting API Documentation Ingestion Pipeline ---");

  try {
    const tool = new IngestionTool(openaiApiKey);
    const result = await tool.run(
      postmanPath,
      collectionName,
      companyName,
      storagePath
    );
    console.log(`\n--- Pipeline completed. Ingested: ${result} ---`);
    return result;
  } catch (error) {
    console.error("❌ Error running ingestion tool:", error);
    return false;
  }
}

// --- STANDALONE EXECUTION BLOCK ---
if (require.main === module) {
  async function localTest() {
    console.log("--- 🧪 Running in standalone test mode ---");

    dotenv.config({ path: path.resolve(__dirname, "../.env") });
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey) {
      throw new Error("OPENAI_API_KEY is not set in your .env file.");
    }

    const companyName = "Shiprocket";
    const collectionName = "shiprocket_v1";
    const postmanPath = path.join(
      __dirname,
      "../ShiprocketAPI.postman_collection.json"
    );
    const storagePath = path.join(__dirname, "..");

    console.log(`Looking for Postman file at: ${postmanPath}`);

    try {
      const tool = new IngestionTool(openaiApiKey);
      const success = await tool.run(
        postmanPath,
        collectionName,
        companyName,
        storagePath
      );

      if (success) {
        console.log("\n--- ✅ Ingestion pipeline completed successfully! ---");
      } else {
        console.log(
          "\n--- ❌ Ingestion pipeline failed. Check logs for details. ---"
        );
      }
    } catch (error) {
      console.error("\nAn unexpected error occurred:", error);
    }
  }

  localTest();
}
