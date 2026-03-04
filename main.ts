import { App, Editor, EditorPosition, MarkdownView, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

type SummaryProvider = "gemini" | "openai";

interface GeminiLinkSummarizerSettings {
  provider: SummaryProvider;
  geminiApiKey: string;
  geminiModelName: string;
  openaiApiKey: string;
  openaiModelName: string;
  customPrompt: string;
  includeTimestamp: boolean;
  summaryMinChars: number;
  summaryMaxChars: number;
}

interface LegacySettings {
  apiKey?: string;
  modelName?: string;
  summaryLengthChars?: number;
}

interface UrlTarget {
  rawUrl: string;
  insertBefore: EditorPosition;
}

const DEFAULT_SETTINGS: GeminiLinkSummarizerSettings = {
  provider: "gemini",
  geminiApiKey: "",
  geminiModelName: "gemini-3.1-flash-lite-preview",
  openaiApiKey: "",
  openaiModelName: "gpt-5.3-chat-latest",
  customPrompt: "",
  includeTimestamp: false,
  summaryMinChars: 200,
  summaryMaxChars: 600
};

const MENU_TITLE = "Summarize link";
const NOTICE_PREFIX = "AI link summarizer";
const UNREADABLE_PAGE_ERROR = "UNREADABLE_PAGE";
const EMPTY_SUMMARY_ERROR = "EMPTY_SUMMARY";
const MIN_SUMMARY_LENGTH_CHARS = 200;
const MAX_SUMMARY_LENGTH_CHARS = 2000;
const FLASH_MODEL_PRESETS = ["gemini-3.1-flash-lite-preview", "gemini-3.0-flash-preview"] as const;
const OPENAI_MODEL_PRESETS = ["gpt-5.3-chat-latest", "gpt-5.2"] as const;

function clampSummaryLengthChars(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_SUMMARY_LENGTH_CHARS;
  }

  return Math.min(MAX_SUMMARY_LENGTH_CHARS, Math.max(MIN_SUMMARY_LENGTH_CHARS, Math.round(value)));
}

function normalizeSummaryRange(minValue: number, maxValue: number): { min: number; max: number } {
  const min = clampSummaryLengthChars(minValue);
  const max = clampSummaryLengthChars(maxValue);

  if (min <= max) {
    return { min, max };
  }

  return { min: max, max: min };
}

function parseSummaryRangeInput(value: string): { min: number; max: number } | null {
  const match = value.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    return null;
  }

  return normalizeSummaryRange(Number.parseInt(match[1], 10), Number.parseInt(match[2], 10));
}

function formatSummaryRange(minValue: number, maxValue: number): string {
  const range = normalizeSummaryRange(minValue, maxValue);
  return `${range.min}-${range.max}`;
}

export default class GeminiLinkSummarizerPlugin extends Plugin {
  settings: GeminiLinkSummarizerSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new GeminiLinkSummarizerSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const target = this.extractUrlFromEditor(editor);
        if (!target) {
          return;
        }

        menu.addItem((item) => {
          item.setTitle(MENU_TITLE).onClick(async () => {
            await this.handleSummarizeClick(editor, target);
          });
        });
      })
    );
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<GeminiLinkSummarizerSettings> & LegacySettings;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    if (!this.settings.geminiApiKey && typeof loaded.apiKey === "string") {
      this.settings.geminiApiKey = loaded.apiKey;
    }
    if (!this.settings.geminiModelName && typeof loaded.modelName === "string") {
      this.settings.geminiModelName = loaded.modelName;
    }
    if (typeof loaded.summaryLengthChars === "number") {
      const legacyTarget = clampSummaryLengthChars(loaded.summaryLengthChars);
      const migratedRange = normalizeSummaryRange(legacyTarget - 100, legacyTarget + 100);
      this.settings.summaryMinChars = migratedRange.min;
      this.settings.summaryMaxChars = migratedRange.max;
    }
    const normalizedRange = normalizeSummaryRange(this.settings.summaryMinChars, this.settings.summaryMaxChars);
    this.settings.summaryMinChars = normalizedRange.min;
    this.settings.summaryMaxChars = normalizedRange.max;
    this.settings.provider = this.settings.provider === "openai" ? "openai" : "gemini";
    this.settings.geminiModelName = this.settings.geminiModelName.trim() || DEFAULT_SETTINGS.geminiModelName;
    this.settings.openaiModelName = this.settings.openaiModelName.trim() || DEFAULT_SETTINGS.openaiModelName;
    this.settings.geminiApiKey = this.settings.geminiApiKey.trim();
    this.settings.openaiApiKey = this.settings.openaiApiKey.trim();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async handleSummarizeClick(editorFromMenu: Editor, target: UrlTarget): Promise<void> {
    const activeEditor = this.getActiveEditor();
    if (!activeEditor) {
      new Notice(`${NOTICE_PREFIX}: no active editor.`);
      return;
    }

    const editor = editorFromMenu;
    const cleanedUrl = this.cleanExtractedUrl(target.rawUrl);

    if (!cleanedUrl) {
      new Notice(`${NOTICE_PREFIX}: no URL found.`);
      return;
    }

    if (!this.isValidHttpUrl(cleanedUrl)) {
      new Notice(`${NOTICE_PREFIX}: invalid URL.`);
      return;
    }

    if (!this.getActiveApiKey()) {
      new Notice(`${NOTICE_PREFIX}: add your ${this.getActiveProviderLabel()} API key in plugin settings.`);
      return;
    }

    try {
      const summary = await this.requestSummary(cleanedUrl);
      const output = `${this.formatOutput(summary)}\n`;
      editor.replaceRange(output, target.insertBefore);
      new Notice(`${NOTICE_PREFIX}: summary inserted.`);
    } catch (error: unknown) {
      new Notice(this.toNoticeMessage(error));
    }
  }

  private getActiveEditor(): Editor | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.editor ?? null;
  }

  private extractUrlFromEditor(editor: Editor): UrlTarget | null {
    const selection = editor.getSelection();
    if (selection.length > 0) {
      const fromSelection = this.extractUrlFromText(selection, editor.getCursor("from"));
      if (fromSelection) {
        return fromSelection;
      }
    }

    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    return this.extractUrlFromLineAtPosition(line, cursor.line, cursor.ch);
  }

  private extractUrlFromText(text: string, basePos: EditorPosition): UrlTarget | null {
    const markdownLinkMatch = /\[[^\]]*]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/i.exec(text);
    if (markdownLinkMatch?.[1] && markdownLinkMatch.index !== undefined) {
      return {
        rawUrl: markdownLinkMatch[1],
        insertBefore: this.addTextOffset(basePos, text, markdownLinkMatch.index)
      };
    }

    const rawUrlMatch = /https?:\/\/[^\s<>"'`]+/i.exec(text);
    if (rawUrlMatch?.[0] && rawUrlMatch.index !== undefined) {
      return {
        rawUrl: rawUrlMatch[0],
        insertBefore: this.addTextOffset(basePos, text, rawUrlMatch.index)
      };
    }

    return null;
  }

  private extractUrlFromLineAtPosition(line: string, lineNumber: number, cursorCh: number): UrlTarget | null {
    const markdownRegex = /\[[^\]]*]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi;
    for (const match of line.matchAll(markdownRegex)) {
      const matchIndex = match.index ?? -1;
      const matchEnd = matchIndex + match[0].length;
      if (matchIndex <= cursorCh && cursorCh <= matchEnd) {
        return match[1]
          ? {
              rawUrl: match[1],
              insertBefore: { line: lineNumber, ch: matchIndex }
            }
          : null;
      }
    }

    const rawUrlRegex = /https?:\/\/[^\s<>"'`]+/gi;
    for (const match of line.matchAll(rawUrlRegex)) {
      const matchIndex = match.index ?? -1;
      const matchEnd = matchIndex + match[0].length;
      if (matchIndex <= cursorCh && cursorCh <= matchEnd) {
        return {
          rawUrl: match[0],
          insertBefore: { line: lineNumber, ch: matchIndex }
        };
      }
    }

    return null;
  }

  private addTextOffset(basePos: EditorPosition, text: string, offset: number): EditorPosition {
    const boundedOffset = Math.max(0, Math.min(offset, text.length));
    const before = text.slice(0, boundedOffset);
    const lines = before.split("\n");

    if (lines.length === 1) {
      return { line: basePos.line, ch: basePos.ch + lines[0].length };
    }

    return {
      line: basePos.line + lines.length - 1,
      ch: lines[lines.length - 1].length
    };
  }

  private cleanExtractedUrl(url: string): string {
    let cleaned = url.trim();
    if (cleaned.startsWith("<") && cleaned.endsWith(">")) {
      cleaned = cleaned.slice(1, -1);
    }

    cleaned = cleaned.replace(/[.,!?;:]+$/g, "");

    while (cleaned.endsWith(")") && !this.hasBalancedParentheses(cleaned)) {
      cleaned = cleaned.slice(0, -1);
    }

    return cleaned;
  }

  private hasBalancedParentheses(value: string): boolean {
    let open = 0;
    for (const char of value) {
      if (char === "(") {
        open += 1;
      } else if (char === ")") {
        if (open === 0) {
          return false;
        }
        open -= 1;
      }
    }

    return open === 0;
  }

  private isValidHttpUrl(value: string): boolean {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  private getActiveProviderLabel(): string {
    return this.settings.provider === "openai" ? "OpenAI" : "Gemini";
  }

  private getActiveApiKey(): string {
    return this.settings.provider === "openai" ? this.settings.openaiApiKey.trim() : this.settings.geminiApiKey.trim();
  }

  private getSummaryRange(): { min: number; max: number } {
    return normalizeSummaryRange(this.settings.summaryMinChars, this.settings.summaryMaxChars);
  }

  private async requestSummary(url: string): Promise<string> {
    return this.settings.provider === "openai" ? this.requestOpenAiSummary(url) : this.requestGeminiSummary(url);
  }

  private async requestGeminiSummary(url: string): Promise<string> {
    const ai = new GoogleGenAI({ apiKey: this.settings.geminiApiKey.trim() });
    const model = this.settings.geminiModelName.trim() || DEFAULT_SETTINGS.geminiModelName;
    const prompt = this.buildSummaryPrompt(url);

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        tools: [{ urlContext: {} }]
      }
    });

    const responseText = this.extractResponseText(response);
    if (!responseText) {
      throw new Error(EMPTY_SUMMARY_ERROR);
    }

    const normalized = responseText.replace(/\s+/g, " ").trim();
    if (!normalized) {
      throw new Error(UNREADABLE_PAGE_ERROR);
    }

    return this.fitSummaryLength(normalized);
  }

  private async requestOpenAiSummary(url: string): Promise<string> {
    const client = new OpenAI({
      apiKey: this.settings.openaiApiKey.trim(),
      dangerouslyAllowBrowser: true
    });
    const model = this.settings.openaiModelName.trim() || DEFAULT_SETTINGS.openaiModelName;
    const prompt = this.buildOpenAiPrompt(url);

    const response = await client.responses.create({
      model,
      tools: [{ type: "web_search_preview" }],
      input: prompt
    });

    const outputText = this.extractOpenAiResponseText(response);
    if (!outputText) {
      throw new Error(EMPTY_SUMMARY_ERROR);
    }

    const normalized = outputText.replace(/\s+/g, " ").trim();
    if (!normalized) {
      throw new Error(UNREADABLE_PAGE_ERROR);
    }

    return this.fitSummaryLength(normalized);
  }

  private buildSummaryPrompt(url: string): string {
    const customPrompt = this.settings.customPrompt.trim();
    const { min: minLength, max: maxLength } = this.getSummaryRange();
    const target = Math.round((minLength + maxLength) / 2);
    const basePrompt =
      customPrompt.length > 0
        ? customPrompt
        : "Use URL Context to read the provided URL and summarize the page.";
    const constraints = [
      "Write exactly one plain-text paragraph.",
      `Target length is about ${target} characters (aim for ${minLength} to ${maxLength}).`,
      "End at a full sentence boundary and do not cut off in the middle of a sentence.",
      "Do not use bullet points."
    ].join(" ");

    return `${basePrompt}\n\nAdditional requirements: ${constraints}\n\nURL: ${url}`;
  }

  private buildOpenAiPrompt(url: string): string {
    const core = this.buildSummaryPrompt(url);
    return `Use the web search tool to fetch and read this exact URL, then answer.\n${core}`;
  }

  private fitSummaryLength(summary: string): string {
    const { min: minLength, max: maxLength } = this.getSummaryRange();
    if (summary.length <= maxLength) {
      return summary;
    }

    const candidate = summary.slice(0, maxLength);
    const sentenceBoundaryIndex = this.findLastSentenceBoundaryIndex(candidate);
    if (sentenceBoundaryIndex >= minLength) {
      return candidate.slice(0, sentenceBoundaryIndex).trim();
    }

    return summary;
  }

  private findLastSentenceBoundaryIndex(text: string): number {
    let boundaryIndex = -1;
    const sentenceBoundaryRegex = /[.!?](?=\s|$)/g;
    let match = sentenceBoundaryRegex.exec(text);
    while (match) {
      boundaryIndex = match.index + 1;
      match = sentenceBoundaryRegex.exec(text);
    }
    return boundaryIndex;
  }

  private extractResponseText(response: unknown): string {
    const responseObj = response as Record<string, unknown>;
    const textValue = responseObj.text;

    if (typeof textValue === "string") {
      return textValue.trim();
    }

    const candidates = responseObj.candidates;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      return "";
    }

    const firstCandidate = candidates[0] as Record<string, unknown>;
    const content = firstCandidate.content as Record<string, unknown> | undefined;
    const parts = content?.parts;
    if (!Array.isArray(parts)) {
      return "";
    }

    return parts
      .map((part) => {
        const partObj = part as Record<string, unknown>;
        return typeof partObj.text === "string" ? partObj.text : "";
      })
      .filter((partText) => partText.length > 0)
      .join("\n")
      .trim();
  }

  private extractOpenAiResponseText(response: unknown): string {
    const responseObj = response as Record<string, unknown>;
    const outputText = responseObj.output_text;
    if (typeof outputText === "string" && outputText.trim().length > 0) {
      return outputText.trim();
    }

    const output = responseObj.output;
    if (!Array.isArray(output)) {
      return "";
    }

    const chunks: string[] = [];
    for (const entry of output) {
      const entryObj = entry as Record<string, unknown>;
      const content = entryObj.content;
      if (!Array.isArray(content)) {
        continue;
      }

      for (const part of content) {
        const partObj = part as Record<string, unknown>;
        if (typeof partObj.text === "string" && partObj.text.trim().length > 0) {
          chunks.push(partObj.text.trim());
        }
      }
    }

    return chunks.join("\n").trim();
  }

  private formatOutput(summary: string): string {
    if (!this.settings.includeTimestamp) {
      return summary;
    }

    const timestamp = new Date().toLocaleString();
    return `[${timestamp}] ${summary}`;
  }

  private toNoticeMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const provider = this.getActiveProviderLabel();

    if (message === UNREADABLE_PAGE_ERROR || message === EMPTY_SUMMARY_ERROR) {
      return `${NOTICE_PREFIX}: unsupported or unreadable page.`;
    }

    if (lower.includes("api key") || lower.includes("unauth") || lower.includes("permission")) {
      return `${NOTICE_PREFIX}: ${provider} request failed. Check API key and model settings.`;
    }

    if (
      lower.includes("unsupported") ||
      lower.includes("unreadable") ||
      lower.includes("cannot fetch") ||
      lower.includes("unable to fetch") ||
      lower.includes("url context")
    ) {
      return `${NOTICE_PREFIX}: unsupported or unreadable page.`;
    }

    return `${NOTICE_PREFIX}: ${provider} request failure (${message}).`;
  }
}

class GeminiLinkSummarizerSettingTab extends PluginSettingTab {
  plugin: GeminiLinkSummarizerPlugin;

  constructor(app: App, plugin: GeminiLinkSummarizerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("AI link summarizer").setHeading();

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Select which provider to use for link summaries.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("gemini", "Gemini")
          .addOption("openai", "OpenAI")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value === "openai" ? "openai" : "gemini";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl).setName("Summary settings").setHeading();

    new Setting(containerEl)
      .setName("Summary length range (characters)")
      .setDesc(`Use the format min-max (for example 200-600). Minimum value is ${MIN_SUMMARY_LENGTH_CHARS}.`)
      .addText((text) =>
        text
          .setPlaceholder(formatSummaryRange(DEFAULT_SETTINGS.summaryMinChars, DEFAULT_SETTINGS.summaryMaxChars))
          .setValue(formatSummaryRange(this.plugin.settings.summaryMinChars, this.plugin.settings.summaryMaxChars))
          .onChange(async (value) => {
            const parsedRange = parseSummaryRangeInput(value);
            if (!parsedRange) {
              return;
            }

            this.plugin.settings.summaryMinChars = parsedRange.min;
            this.plugin.settings.summaryMaxChars = parsedRange.max;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Custom prompt (optional)")
      .setDesc("Overrides the default summarization prompt.")
      .addTextArea((textArea) =>
        textArea.setValue(this.plugin.settings.customPrompt).onChange(async (value) => {
          this.plugin.settings.customPrompt = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Include timestamp")
      .setDesc("Prepends the current timestamp before the inserted summary.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeTimestamp).onChange(async (value) => {
          this.plugin.settings.includeTimestamp = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl).setName("Gemini settings").setHeading();

    new Setting(containerEl)
      .setName("Gemini API key")
      .setDesc("API key used for Gemini requests.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.geminiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.geminiApiKey = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Gemini model name")
      .setDesc("Gemini model to use. You can type any model name.")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.geminiModelName)
          .onChange(async (value) => {
            this.plugin.settings.geminiModelName = value.trim() || DEFAULT_SETTINGS.geminiModelName;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Flash model presets")
      .setDesc("Quickly choose a recent Flash preview model.")
      .addButton((button) =>
        button.setButtonText("3.1 flash lite preview").onClick(async () => {
          this.plugin.settings.geminiModelName = FLASH_MODEL_PRESETS[0];
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("3.0 flash preview").onClick(async () => {
          this.plugin.settings.geminiModelName = FLASH_MODEL_PRESETS[1];
          await this.plugin.saveSettings();
          this.display();
        })
      );

    new Setting(containerEl).setName("OpenAI settings").setHeading();

    new Setting(containerEl)
      .setName("OpenAI API key")
      .setDesc("API key used for OpenAI requests.")
      .addText((text) =>
        text.setValue(this.plugin.settings.openaiApiKey).onChange(async (value) => {
          this.plugin.settings.openaiApiKey = value.trim();
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("OpenAI model name")
      .setDesc("OpenAI model to use. You can type any model name.")
      .addText((text) =>
        text.setValue(this.plugin.settings.openaiModelName).onChange(async (value) => {
          this.plugin.settings.openaiModelName = value.trim() || DEFAULT_SETTINGS.openaiModelName;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("OpenAI model presets")
      .setDesc("Quickly choose a common OpenAI model.")
      .addButton((button) =>
        button.setButtonText("gpt-5.3-chat-latest").onClick(async () => {
          this.plugin.settings.openaiModelName = OPENAI_MODEL_PRESETS[0];
          await this.plugin.saveSettings();
          this.display();
        })
      )
      .addButton((button) =>
        button.setButtonText("gpt-5.2").onClick(async () => {
          this.plugin.settings.openaiModelName = OPENAI_MODEL_PRESETS[1];
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }
}
