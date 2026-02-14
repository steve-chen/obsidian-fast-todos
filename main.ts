import {
  App,
  MarkdownRenderChild,
  Plugin,
  TFile,
  moment,
  Editor,
  MarkdownView,
  Modal,
  Setting,
  MarkdownPostProcessorContext,
} from "obsidian";
import {
  EditorView,
  Decoration,
  DecorationSet,
  WidgetType,
  ViewPlugin,
  ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

interface FastTask {
  text: string;
  completed: boolean;
  line: number;
  path: string;
  completedDate?: string;
  cleanText: string;
  priority: "high" | "normal" | "low";
  dueDate?: string;
  indent: number;
  status: string;
}

export default class FastTodos extends Plugin {
  public lastInternalUpdate: number = 0;
  private completionTimer: number | null = null;
  public completionRegex = /\[(?:completed|completion):\s*[^\]]*\]/i;
  public TaskEditModalClass = TaskEditModal;
  private editorExtension: any;

  async onload() {
    console.log("Loading Fast Todos");

    this.registerMarkdownCodeBlockProcessor(
      "todos",
      async (source, el, ctx) => {
        const child = new FastTodosRenderer(
          el,
          this.app,
          source,
          ctx.sourcePath,
          this,
        );
        ctx.addChild(child);
      },
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor: Editor) => {
        if (this.completionTimer) clearTimeout(this.completionTimer);
        this.completionTimer = window.setTimeout(() => {
          this.processEditorChanges(editor);
        }, 500);
      }),
    );

    this.registerMarkdownPostProcessor((el, ctx) => {
      this.postProcessReadingModeTasks(el, ctx);
    });

    this.editorExtension = editButtonPlugin(this.app, this);
    this.registerEditorExtension(this.editorExtension);

    FastTodosRenderer.warmCache(this.app, this);
  }

  onunload() {
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
    }
    FastTodosRenderer.clearCache();
  }

  private processEditorChanges(editor: Editor) {
    const lineCount = editor.lineCount();
    let changesMade = false;
    const activeFile = this.app.workspace.getActiveFile();
    const cursor = editor.getCursor();
    let cursorOffset = 0;

    for (let i = 0; i < lineCount; i++) {
      const line = editor.getLine(i);
      const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[([ xX\-])\]\s*)(.*)/);
      if (!taskMatch) continue;

      const isDone = taskMatch[2].toLowerCase() === "x";
      const hasTag = this.completionRegex.test(line);

      if (activeFile) {
        const taskId = `${activeFile.path}:${i}`;
        (this.app.workspace as any).trigger(
          "fast-todos:status-change",
          taskId,
          isDone,
        );
      }

      if (isDone && !hasTag) {
        const now = moment().format("YYYY-MM-DD");
        const newLine = line.trimEnd() + ` [completed: ${now}]`;
        if (line !== newLine) {
          const cm = (editor as any).cm;
          if (cm) {
            const lineFrom = cm.state.doc.line(i + 1).from;
            const lineTo = cm.state.doc.line(i + 1).to;
            const cursorPos = cm.state.selection.main.head;

            cm.dispatch({
              changes: {
                from: lineFrom,
                to: lineTo,
                insert: newLine,
              },
              scrollIntoView: false,
            });

            if (cursor.line === i) {
              const newCursorPos =
                Math.min(cursorPos - lineFrom, newLine.length) + lineFrom;
              cm.dispatch({
                selection: { anchor: newCursorPos, head: newCursorPos },
              });
            }
          } else {
            if (
              cursor.line === i &&
              cursor.ch > taskMatch[1].length + taskMatch[3].length
            ) {
              cursorOffset = ` [completed: ${now}]`.length;
            }
            editor.setLine(i, newLine);
          }
          changesMade = true;
        }
      } else if (!isDone && hasTag) {
        const newLine = line
          .replace(/\s*\[(?:completed|completion):\s*[^\]]*\]/gi, "")
          .trimEnd();
        if (line !== newLine) {
          const cm = (editor as any).cm;
          if (cm) {
            const lineFrom = cm.state.doc.line(i + 1).from;
            const lineTo = cm.state.doc.line(i + 1).to;
            const cursorPos = cm.state.selection.main.head;

            cm.dispatch({
              changes: {
                from: lineFrom,
                to: lineTo,
                insert: newLine,
              },
              scrollIntoView: false,
            });

            if (cursor.line === i) {
              const newCursorPos =
                Math.min(cursorPos - lineFrom, newLine.length) + lineFrom;
              cm.dispatch({
                selection: { anchor: newCursorPos, head: newCursorPos },
              });
            }
          } else {
            if (cursor.line === i) {
              const removedLength = line.length - newLine.length;
              if (cursor.ch > newLine.length) {
                cursorOffset = -removedLength;
              }
            }
            editor.setLine(i, newLine);
          }
          changesMade = true;
        }
      }
    }

    if (cursorOffset !== 0 && !(editor as any).cm) {
      editor.setCursor({
        line: cursor.line,
        ch: Math.max(0, cursor.ch + cursorOffset),
      });
    }

    if (changesMade) {
      this.lastInternalUpdate = Date.now();
      FastTodosRenderer.clearCache();
    }
  }

  private postProcessReadingModeTasks(
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ) {
    const taskItems = el.querySelectorAll(".task-list-item");
    if (taskItems.length === 0) return;

    taskItems.forEach((item, domIndex) => {
      if (!(item as HTMLElement).querySelector(".fast-todos-inline-edit")) {
        const editBtn = item.createSpan({
          cls: "fast-todos-inline-edit",
          text: "EDIT",
        });
        editBtn.onclick = async (e) => {
          e.preventDefault();
          e.stopPropagation();

          const section = ctx.getSectionInfo(el);
          if (!section) return;

          const file = this.app.vault.getAbstractFileByPath(
            ctx.sourcePath,
          ) as TFile;
          if (!file || !(file instanceof TFile)) return;

          const content = await this.app.vault.read(file);
          const lines = content.split("\n");

          const taskLineIndices: number[] = [];
          for (let i = section.lineStart; i <= section.lineEnd; i++) {
            const line = lines[i];
            if (line && line.match(/^\s*[-*+\d\.\s]*\s*\[[ xX\-]\]/)) {
              taskLineIndices.push(i);
            }
          }

          const targetLineNum = taskLineIndices[domIndex];
          if (targetLineNum === undefined) return;

          const line = lines[targetLineNum];
          if (!line) return;

          const taskStatusMatch = line.match(/\[([ xX\-])\]/);
          const isCompleted = taskStatusMatch
            ? taskStatusMatch[1].toLowerCase() === "x"
            : false;
          const targetTask = this.parseTaskLine(
            line,
            targetLineNum,
            file.path,
            isCompleted,
          );

          new TaskEditModal(this.app, targetTask, async (result) => {
            await this.handleTaskUpdate(file, targetTask, result);
          }).open();
        };
      }

      const matches = item.innerHTML.match(
        /\[(?:completed|completion):\s*[^\]]*\]/i,
      );
      if (matches) {
        const tagText = matches[0];
        const stampHtml = `<span class="fast-todos-completion-stamp">${tagText}</span>`;
        item.innerHTML = item.innerHTML.replace(tagText, stampHtml);
      }
    });
  }

  parseTaskLine(
    line: string,
    lineNum: number,
    path: string,
    isCompleted: boolean,
  ): FastTask {
    const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[(.)\])(.*)/);
    const rawContent = taskMatch ? taskMatch[3] : line;
    const status = taskMatch ? taskMatch[2] : " ";
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    const completedMatch = rawContent.match(
      /\[(completed|completion):+\s*([^\]]+)\]/i,
    );
    const priorityMatch = rawContent.match(
      /\[priority:+\s*(high|normal|low)\]/i,
    );
    const dueMatch = rawContent.match(/\[due:+\s*(\d{4}-\d{2}-\d{2})\]/i);

    let displayDescription = rawContent
      .replace(/\[(created|completed|completion|due|priority):+[^\]]+\]/gi, "")
      .trim();

    return {
      text: line,
      cleanText: displayDescription || "(No Description)",
      completed: isCompleted,
      line: lineNum,
      path,
      completedDate: completedMatch ? completedMatch[2] : undefined,
      priority: priorityMatch
        ? (priorityMatch[1].toLowerCase() as any)
        : "normal",
      dueDate: dueMatch ? dueMatch[1] : undefined,
      indent,
      status,
    };
  }

  async handleTaskUpdate(
    file: TFile,
    task: FastTask,
    result: {
      description: string;
      completed: boolean;
      priority: "high" | "normal" | "low";
      dueDate?: string;
    },
  ) {
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      if (task.line >= lines.length) return;

      let line = lines[task.line];
      if (!line) return;

      const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX\-]\]\s*)(.*)/);
      if (!taskMatch) return;

      const prefix = taskMatch[1];
      const basePrefix = prefix.replace(
        /\[.\]/,
        result.completed ? "[x]" : "[ ]",
      );

      let cleanDesc = result.description
        .replace(
          /\[(?:priority|completed|completion|created|due):+[^\]]+\]/gi,
          "",
        )
        .trim();

      if (result.priority && result.priority !== "normal") {
        cleanDesc += ` [priority: ${result.priority}]`;
      }
      if (result.dueDate) {
        cleanDesc += ` [due: ${result.dueDate}]`;
      }

      let finalLine = basePrefix + cleanDesc;
      if (result.completed) {
        const now = moment().format("YYYY-MM-DD");
        if (!finalLine.includes("[completed:")) {
          finalLine += ` [completed: ${now}]`;
        }
      } else {
        finalLine = finalLine
          .replace(/\[(?:completed|completion):\s*[^\]]*\]/gi, "")
          .trimEnd();
      }

      await this.safeModifyLine(file, task.line, finalLine.trimEnd());
    } catch (e) {
      console.error("Update Task failed:", e);
    }
  }

  async safeModifyLine(file: TFile, lineNum: number, newLine: string) {
    this.lastInternalUpdate = Date.now();
    let editorUsed = false;

    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        leaf.view instanceof MarkdownView &&
        leaf.view.file?.path === file.path
      ) {
        leaf.view.editor.setLine(lineNum, newLine);
        editorUsed = true;
      }
    });

    if (!editorUsed) {
      await this.app.vault.process(file, (data) => {
        const lines = data.split("\n");
        lines[lineNum] = newLine;
        return lines.join("\n");
      });
    }
  }

  escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}

class TaskEditModal extends Modal {
  result: {
    description: string;
    completed: boolean;
    priority: "high" | "normal" | "low";
    dueDate: string;
  };

  constructor(
    app: App,
    public task: FastTask,
    public onSubmit: (result: {
      description: string;
      completed: boolean;
      priority: "high" | "normal" | "low";
      dueDate?: string;
    }) => void,
  ) {
    super(app);
    this.result = {
      description: task.cleanText === "(No Description)" ? "" : task.cleanText,
      completed: task.completed,
      priority: task.priority,
      dueDate: task.dueDate || "",
    };
  }

  onOpen() {
    const { contentEl } = this;
    this.containerEl.addClass("fast-todos-modal");
    contentEl.createEl("h2", { text: "Edit Task" });

    const descContainer = contentEl.createDiv({
      cls: "fast-modal-description",
    });
    descContainer.createEl("label", {
      text: "Description",
      cls: "fast-modal-label",
    });
    const textarea = descContainer.createEl("textarea", {
      placeholder: "Task description...",
    });
    textarea.value = this.result.description;
    textarea.oninput = (e) =>
      (this.result.description = (e.target as HTMLTextAreaElement).value);

    new Setting(contentEl).setName("Due Date").addText((text) => {
      text.inputEl.type = "date";
      text
        .setValue(this.result.dueDate)
        .onChange((value) => (this.result.dueDate = value));
    });

    new Setting(contentEl)
      .setName("Completed Status")
      .addToggle((toggle) =>
        toggle
          .setValue(this.result.completed)
          .onChange((value) => (this.result.completed = value)),
      );

    new Setting(contentEl).setName("Priority").addDropdown((dropdown) =>
      dropdown
        .addOption("high", "High")
        .addOption("normal", "Normal")
        .addOption("low", "Low")
        .setValue(this.result.priority)
        .onChange((value) => (this.result.priority = value as any)),
    );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          this.close();
          this.onSubmit({
            description: this.result.description,
            completed: this.result.completed,
            priority: this.result.priority,
            dueDate: this.result.dueDate || undefined,
          });
        }),
    );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

class FastTodosRenderer extends MarkdownRenderChild {
  private static taskCache: FastTask[] = [];
  private static lastScanTime: number = 0;
  private static isWarmingCache: boolean = false;
  private static cachePromise: Promise<FastTask[]> | null = null;
  private lastRenderedHash: string = "";
  private completionRegex = /\[(?:completed|completion):\s*[^\]]*\]/gi;
  private refreshTimer: number | null = null;
  private activeCountdowns: Set<string> = new Set();
  private selectedTaskId: string | null = null;
  private itemElements: HTMLElement[] = [];

  private static readonly CACHE_TTL = 2 * 60 * 1000;

  constructor(
    public containerEl: HTMLElement,
    public app: App,
    public source: string,
    public sourcePath: string,
    public plugin: FastTodos,
  ) {
    super(containerEl);
  }

  static clearCache() {
    FastTodosRenderer.lastScanTime = 0;
    FastTodosRenderer.taskCache = [];
  }

  async onload() {
    this.render();

    this.containerEl.setAttribute("tabindex", "0");
    this.registerDomEvent(this.containerEl, "keydown", (e: KeyboardEvent) => {
      this.handleKeyDown(e);
    });

    this.registerEvent(
      (this.app.workspace as any).on(
        "fast-todos:status-change",
        (taskId: string, isDone: boolean) => {
          const itemEl = this.containerEl.querySelector(
            `[data-task-id="${taskId}"]`,
          ) as HTMLElement;
          const taskInView = FastTodosRenderer.taskCache.find(
            (t) => `${t.path}:${t.line}` === taskId,
          );

          if (itemEl && taskInView) {
            if (isDone) {
              taskInView.completed = true;
              this.applyVisualDone(itemEl, true);
            } else {
              taskInView.completed = false;
              this.activeCountdowns.delete(taskId);
              this.applyVisualDone(itemEl, false);
              const countdown = itemEl.querySelector(".fast-todos-countdown");
              if (countdown) countdown.remove();
            }
          }
        },
      ),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.activeCountdowns.size > 0) return;

        const delay =
          Date.now() - this.plugin.lastInternalUpdate < 3000 ? 1000 : 500;

        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
          FastTodosRenderer.clearCache();
          this.render();
        }, delay);
      }),
    );

    this.registerEvent(
      (this.app.workspace as any).on("fast-todos:refresh-all", () => {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = window.setTimeout(() => {
          FastTodosRenderer.clearCache();
          this.lastRenderedHash = "";
          this.render();
        }, 400);
      }),
    );
  }

  onunload() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
  }

  private applyVisualDone(itemEl: HTMLElement, isDone: boolean) {
    const checkbox = itemEl.querySelector(
      ".fast-todos-checkbox",
    ) as HTMLInputElement;
    const textSpan = itemEl.querySelector(".fast-todos-text") as HTMLElement;
    if (checkbox) {
      checkbox.checked = isDone;
      if (isDone) checkbox.setAttribute("checked", "checked");
      else checkbox.removeAttribute("checked");
    }
    if (textSpan) {
      if (isDone) textSpan.classList.add("fast-todos-completed");
      else textSpan.classList.remove("fast-todos-completed");
    }
  }

  async render() {
    if (!this.containerEl) return;

    const isFirstRender = this.lastRenderedHash === "";
    if (isFirstRender && FastTodosRenderer.taskCache.length === 0) {
      this.containerEl.empty();
      this.containerEl.addClass("fast-todos-container");
      this.containerEl.createDiv({
        text: "Loading tasks...",
        cls: "fast-todos-loading",
      });
    }

    const tasks = await this.getTasks();


    const loadingEl = this.containerEl.querySelector(".fast-todos-loading");
    if (loadingEl) loadingEl.remove();

    const config = this.parseConfig(this.source);
    const today = moment().format("YYYY-MM-DD");

    let filteredTasks = tasks.filter((t) => {
      return config.filters.every((filter) => filter(t, today));
    });

    if (config.sortBy) {
      filteredTasks.sort((a, b) => {
        if (config.sortBy === "priority") {
          const weight: any = { high: 3, normal: 2, low: 1 };
          const wa = weight[a.priority] || 2;
          const wb = weight[b.priority] || 2;
          return wb - wa;
        }
        if (config.sortBy === "path")
          return (a.path || "").localeCompare(b.path || "");
        if (config.sortBy === "description" || config.sortBy === "alphabet")
          return (a.cleanText || "").localeCompare(b.cleanText || "");
        if (config.sortBy === "date")
          return (a.completedDate || "").localeCompare(b.completedDate || "");
        if (config.sortBy === "due") {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        }
        return 0;
      });
    }

    if (config.limit !== undefined) {
      filteredTasks = filteredTasks.slice(0, config.limit);
    }

    const currentHash = JSON.stringify(
      filteredTasks.map((t) => ({
        p: t.path,
        l: t.line,
        c: t.completed,
        t: t.cleanText,
        pr: t.priority,
        d: t.dueDate,
      })),
    );

    if (currentHash === this.lastRenderedHash) return;
    this.lastRenderedHash = currentHash;

    this.itemElements = [];

    try {
      this.containerEl.empty();
      this.containerEl.addClass("fast-todos-container");

      if (filteredTasks.length === 0) {
        this.containerEl.createDiv({
          text: "No matching tasks.",
          cls: "fast-todos-empty",
        });
        return;
      }

      const groups = this.groupTasks(filteredTasks, config.groupBy);
      for (const [groupName, fileTasks] of Object.entries(groups)) {
        if (!fileTasks || fileTasks.length === 0) continue;

        const groupWrap = this.containerEl.createDiv({
          cls: "fast-todos-group",
        });
        const header = groupWrap.createDiv({ cls: "fast-todos-header" });

        const firstTask = fileTasks[0];
        const possibleFile = this.app.vault.getAbstractFileByPath(
          firstTask.path,
        ) as TFile;

        const completedCount = fileTasks.filter((t) => t.completed).length;
        const totalCount = fileTasks.length;
        const unfinishedCount = totalCount - completedCount;
        const progressPercent = Math.round((completedCount / totalCount) * 100);

        const headerContent = header.createDiv({
          cls: "fast-todos-header-content",
        });
        const taskText = unfinishedCount === 1 ? "task" : "tasks";
        const displayText = `${groupName} (${unfinishedCount} ${taskText})`;
        const link = headerContent.createEl("a", {
          text: displayText,
          cls: "fast-todos-file-link",
        });

        if (possibleFile) {
          link.onclick = () =>
            this.app.workspace.getLeaf(false).openFile(possibleFile);
        }

        const list = groupWrap.createDiv({ cls: "fast-todos-list" });
        for (const task of fileTasks) {
          const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
          if (file) {
            this.renderTask(list, task, file);
          }
        }
      }

      // Initial selection if none
      if (!this.selectedTaskId && this.itemElements.length > 0) {
        // Don't auto-select on first render
      }
    } catch (e) {
      console.error("Fast Todos Render Error:", e);
      this.containerEl.createDiv({
        text: "Error rendering tasks. Check console.",
        cls: "fast-todos-empty",
      });
    }
  }

  private async handleKeyDown(e: KeyboardEvent) {
    const tasks = this.itemElements;
    if (tasks.length === 0) return;

    let currentIndex = tasks.findIndex(
      (el) => el.getAttribute("data-task-id") === this.selectedTaskId,
    );

    if (e.key === "j" || e.key === "ArrowDown") {
      e.preventDefault();
      currentIndex++;
      if (currentIndex >= tasks.length) currentIndex = 0;
      this.selectTaskByIndex(currentIndex);
    } else if (e.key === "k" || e.key === "ArrowUp") {
      e.preventDefault();
      currentIndex--;
      if (currentIndex < 0) currentIndex = tasks.length - 1;
      this.selectTaskByIndex(currentIndex);
    } else if (e.key === "x" || e.key === " ") {
      e.preventDefault();
      if (this.selectedTaskId) {
        const itemEl = tasks[currentIndex];
        const task = FastTodosRenderer.taskCache.find(
          (t) => `${t.path}:${t.line}` === this.selectedTaskId,
        );
        if (task && itemEl) {
          const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
          if (file) {
            await this.cycleTaskStatus(task, file, itemEl);
          }
        }
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (this.selectedTaskId) {
        const task = FastTodosRenderer.taskCache.find(
          (t) => `${t.path}:${t.line}` === this.selectedTaskId,
        );
        if (task) {
          const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
          if (file) {
            this.app.workspace
              .getLeaf(false)
              .openFile(file, { eState: { line: task.line } });
          }
        }
      }
    }
  }

  private selectTaskByIndex(index: number) {
    const tasks = this.itemElements;
    if (index < 0 || index >= tasks.length) return;

    // Remove old selection
    tasks.forEach((el) => el.removeClass("is-selected"));

    const selectedEl = tasks[index];
    selectedEl.addClass("is-selected");
    this.selectedTaskId = selectedEl.getAttribute("data-task-id");

    selectedEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  private async handleTaskStatusChange(
    task: FastTask,
    file: TFile,
    status: string,
    itemEl: HTMLElement,
  ) {
    const taskId = `${task.path}:${task.line}`;

    if (status === "x") {
      const newState = !task.completed;
      task.completed = newState;
      task.status = newState ? "x" : " ";

      if (newState) {
        this.startCountdown(taskId, itemEl, task);
      } else {
        this.applyVisualDone(itemEl, false);
        this.activeCountdowns.delete(taskId);
        const existingCountdown = itemEl.querySelector(".fast-todos-countdown");
        if (existingCountdown) existingCountdown.remove();

        const checkbox = itemEl.querySelector(".fast-todos-checkbox");
        if (checkbox) checkbox.setAttribute("data-status", " ");
      }
      await this.setTaskStatus(file, task, task.status);
    } else {
      task.status = status;
      task.completed = (status === "x");

      if (status === "x") {
        this.startCountdown(taskId, itemEl, task);
      } else {
        this.applyVisualDone(itemEl, false);
        this.activeCountdowns.delete(taskId);
        const existingCountdown = itemEl.querySelector(".fast-todos-countdown");
        if (existingCountdown) existingCountdown.remove();

        const checkbox = itemEl.querySelector(".fast-todos-checkbox");
        if (checkbox) checkbox.setAttribute("data-status", status);
      }
      await this.setTaskStatus(file, task, status);
    }

    // Refresh for non-completed changes to ensure visual consistency
    if (task.status !== "x") {
      this.lastRenderedHash = "";
      FastTodosRenderer.clearCache();
      this.render();
    }
  }

  private async cycleTaskStatus(
    task: FastTask,
    file: TFile,
    itemEl: HTMLElement,
  ) {
    const taskId = `${task.path}:${task.line}`;

    // Simple toggle: not started <-> done (skip in-progress)
    const nextStatus = (task.status === "x" || task.completed) ? " " : "x";

    task.status = nextStatus;
    task.completed = nextStatus === "x";

    if (nextStatus === "x") {
      this.startCountdown(taskId, itemEl, task);
    } else {
      this.applyVisualDone(itemEl, false);
      this.activeCountdowns.delete(taskId);
      const existingCountdown = itemEl.querySelector(".fast-todos-countdown");
      if (existingCountdown) existingCountdown.remove();

      const checkbox = itemEl.querySelector(".fast-todos-checkbox");
      if (checkbox) {
        checkbox.setAttribute("data-status", nextStatus);
        (checkbox as HTMLInputElement).checked = false;
      }
    }

    await this.setTaskStatus(file, task, nextStatus);

    // Update cache
    const cached = FastTodosRenderer.taskCache.find(
      (t) => `${t.path}:${t.line}` === taskId,
    );
    if (cached) {
      cached.status = nextStatus;
      cached.completed = task.completed;
    }

    if (nextStatus !== "x") {
      this.lastRenderedHash = "";
      FastTodosRenderer.clearCache();
      this.render();
    }
  }

  private async setTaskStatus(file: TFile, task: FastTask, status: string) {
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      if (task.line >= lines.length) return;

      let line = lines[task.line];
      if (!line) return;

      const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[)(.)(\]\s*)(.*)/);
      if (!taskMatch) return;

      const prefix = taskMatch[1];
      const suffix = taskMatch[3];
      const rawContent = taskMatch[4];
      const now = moment().format("YYYY-MM-DD");

      let cleanContent = rawContent.replace(this.completionRegex, "").trim();
      let finalLine = prefix + status + suffix + cleanContent;

      if (status === "x") {
        if (!finalLine.includes("[completed:")) {
          finalLine += ` [completed: ${now}]`;
        }
      }

      await this.plugin.safeModifyLine(file, task.line, finalLine.trimEnd());
    } catch (e) {
      console.error("Set Task Status failed:", e);
    }
  }

  private completeAllTasks(tasks: FastTask[]) {
    const incompleteTasks = tasks.filter((t) => !t.completed);
    if (incompleteTasks.length === 0) return;

    if (confirm(`Complete all ${incompleteTasks.length} tasks?`)) {
      incompleteTasks.forEach(async (task) => {
        const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
        if (file) {
          task.completed = true;
          await this.toggleTask(file, task);
        }
      });
    }
  }

  async getTasks(): Promise<FastTask[]> {
    const now = Date.now();

    if (
      FastTodosRenderer.taskCache.length > 0 &&
      now - FastTodosRenderer.lastScanTime < FastTodosRenderer.CACHE_TTL
    ) {
      return FastTodosRenderer.taskCache;
    }

    if (FastTodosRenderer.cachePromise) {
      return FastTodosRenderer.cachePromise;
    }

    FastTodosRenderer.cachePromise = this.scanAllTasks();
    try {
      const tasks = await FastTodosRenderer.cachePromise;
      return tasks;
    } finally {
      FastTodosRenderer.cachePromise = null;
    }
  }

  private async scanAllTasks(): Promise<FastTask[]> {
    const allFiles = this.app.vault.getMarkdownFiles();
    const tasks: FastTask[] = [];

    const BATCH_SIZE = 50;

    for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
      const batch = allFiles.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (file) => {
          const cache = this.app.metadataCache.getFileCache(file);
          if (!cache || !cache.listItems) return;

          const hasTasks = cache.listItems.some((item) => item.task);
          if (!hasTasks) return;

          try {
            const content = await this.app.vault.cachedRead(file);
            const lines = content.split("\n");

            for (const item of cache.listItems) {
              if (item.task) {
                const lineText = lines[item.position.start.line];
                if (!lineText) continue;

                const taskStatusMatch = lineText.match(/\[([ xX\-])\]/);
                const isCompleted = taskStatusMatch
                  ? taskStatusMatch[1].toLowerCase() === "x"
                  : item.task === "x" || item.task === "X";

                tasks.push(
                  this.parseTaskLine(
                    lineText,
                    item.position.start.line,
                    file.path,
                    isCompleted,
                  ),
                );
              }
            }
          } catch (e) {
            console.warn("Fast Todos: Could not read file", file.path, e);
          }
        }),
      );

      if (i + BATCH_SIZE < allFiles.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    FastTodosRenderer.taskCache = tasks;
    FastTodosRenderer.lastScanTime = Date.now();
    return tasks;
  }

  static warmCache(app: App, plugin: FastTodos) {
    if (
      FastTodosRenderer.isWarmingCache ||
      FastTodosRenderer.taskCache.length > 0
    ) {
      return;
    }

    FastTodosRenderer.isWarmingCache = true;

    setTimeout(async () => {
      try {
        const dummyEl = document.createElement("div");
        const renderer = new FastTodosRenderer(dummyEl, app, "", "", plugin);
        await renderer.getTasks();
        console.log(
          "Fast Todos: Cache warmed with",
          FastTodosRenderer.taskCache.length,
          "tasks",
        );
      } catch (e) {
        console.error("Fast Todos: Cache warm failed", e);
      } finally {
        FastTodosRenderer.isWarmingCache = false;
      }
    }, 1000);
  }

  parseTaskLine(
    line: string,
    lineNum: number,
    path: string,
    isCompleted: boolean,
  ): FastTask {
    const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[(.)\])(.*)/);
    const rawContent = taskMatch ? taskMatch[3] : line;
    const status = taskMatch ? taskMatch[2] : " ";
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    const completedMatch = rawContent.match(
      /\[(completed|completion):+\s*([^\]]+)\]/i,
    );
    const priorityMatch = rawContent.match(
      /\[priority:+\s*(high|normal|low)\]/i,
    );
    const dueMatch = rawContent.match(/\[due:+\s*(\d{4}-\d{2}-\d{2})\]/i);

    let displayDescription = rawContent
      .replace(/\[(created|completed|completion|due|priority):+[^\]]+\]/gi, "")
      .trim();

    return {
      text: line,
      cleanText: displayDescription || "(No Description)",
      completed: isCompleted,
      line: lineNum,
      path,
      completedDate: completedMatch ? completedMatch[2] : undefined,
      priority: priorityMatch
        ? (priorityMatch[1].toLowerCase() as any)
        : "normal",
      dueDate: dueMatch ? dueMatch[1] : undefined,
      indent,
      status,
    };
  }

  evaluateAtom(atom: string, task: FastTask, today: string): boolean {
    const low = atom.toLowerCase().trim();

    if (low === "not done") {
      return (
        !task.completed ||
        this.activeCountdowns.has(`${task.path}:${task.line}`)
      );
    }
    if (low === "done" || low === "is done") {
      return task.completed;
    }
    if (low === "done today") {
      return task.completed && task.completedDate === today;
    }
    if (low === "due") {
      return !!task.dueDate && task.dueDate <= today && !task.completed;
    }
    if (low === "overdue") {
      return !!task.dueDate && task.dueDate < today && !task.completed;
    }
    if (low.startsWith("due before ")) {
      const date = low.replace("due before ", "").trim();
      return !!task.dueDate && task.dueDate < date;
    }
    if (low.startsWith("due after ")) {
      const date = low.replace("due after ", "").trim();
      return !!task.dueDate && task.dueDate > date;
    }
    if (low.startsWith("path includes ")) {
      const p = low.replace("path includes ", "").trim();
      return task.path.toLowerCase().includes(p);
    }
    if (low.startsWith("tag includes ")) {
      const t = low.replace("tag includes ", "").trim();
      return task.text.toLowerCase().includes(t);
    }
    if (low.startsWith("priority is ")) {
      const p = low.replace("priority is ", "").trim();
      return task.priority === p;
    }
    if (low.startsWith("priority is not ")) {
      const p = low.replace("priority is not ", "").trim();
      return task.priority !== p;
    }
    return true;
  }

  parseConfig(source: string) {
    const lines = source
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const config = {
      filters: [] as ((t: FastTask, today: string) => boolean)[],
      limit: undefined as number | undefined,
      groupBy: "",
      sortBy: "",
    };

    for (const line of lines) {
      const lowLine = line.toLowerCase();

      if (lowLine.startsWith("limit")) {
        const num = parseInt(lowLine.replace("limit", "").trim());
        if (!isNaN(num)) config.limit = num;
        continue;
      }
      if (lowLine.startsWith("group by")) {
        config.groupBy = lowLine.replace("group by", "").trim();
        continue;
      }
      if (lowLine.startsWith("sort by")) {
        config.sortBy = lowLine.replace("sort by", "").trim();
        continue;
      }

      const orParts = line.split(/\s+OR\s+/);
      config.filters.push((task: FastTask, today: string) => {
        return orParts.some((orPart) => {
          const andParts = orPart.split(/\s+AND\s+/);
          return andParts.every((andPart) =>
            this.evaluateAtom(andPart, task, today),
          );
        });
      });
    }
    return config;
  }

  groupTasks(tasks: FastTask[], groupBy: string) {
    const groups: Record<string, FastTask[]> = {};
    for (const task of tasks) {
      let key = task.path.split("/").pop() || task.path;
      if (groupBy === "path") key = task.path;
      if (key.endsWith(".md")) key = key.slice(0, -3);

      if (!groups[key]) groups[key] = [];
      groups[key].push(task);
    }
    return groups;
  }

  private startCountdown(taskId: string, itemEl: HTMLElement, task: FastTask) {
    if (this.activeCountdowns.has(taskId)) return;
    this.activeCountdowns.add(taskId);
    task.completed = true;

    this.applyVisualDone(itemEl, true);

    const countdownSpan = itemEl.createSpan({
      cls: "fast-todos-countdown",
      text: "5",
    });

    let count = 5;
    const interval = window.setInterval(() => {
      if (!this.activeCountdowns.has(taskId)) {
        clearInterval(interval);
        return;
      }
      count--;
      if (count > 0) {
        countdownSpan.setText(count.toString());
      } else {
        clearInterval(interval);
        this.activeCountdowns.delete(taskId);

        this.lastRenderedHash = "";
        FastTodosRenderer.clearCache();
        this.render();
      }
    }, 1000);
  }

  renderTask(parent: HTMLElement, task: FastTask, file: TFile) {
    const taskId = `${task.path}:${task.line}`;
    const item = parent.createDiv({ cls: "fast-todos-item" });
    this.itemElements.push(item);

    if (this.selectedTaskId === taskId) {
      item.addClass("is-selected");
    }

    item.setAttribute("data-task-id", taskId);
    item.setAttribute("data-indent-level", task.indent.toString());

    // Add hierarchy visual indicators for nested tasks
    // Calculate visual indent level: tabs count as 1 level each, every 2-4 spaces count as 1 level
    if (task.indent > 0) {
      const lineText = task.text;
      const leadingWhitespace = lineText.match(/^(\s*)/)?.[1] || "";

      // Count indent levels: each tab = 1 level, every 2-4 spaces = 1 level
      let visualLevel = 0;
      for (const char of leadingWhitespace) {
        if (char === '\t') {
          visualLevel++;
        }
      }

      // If no tabs, count spaces (assume ~2-4 spaces per level, use 3 as middle ground)
      if (visualLevel === 0 && task.indent > 0) {
        visualLevel = Math.floor(task.indent / 3);
      }

      // Create visual guides for each level with tighter spacing
      const indentWidth = 16; // Pixels per indent level
      for (let i = 0; i < visualLevel; i++) {
        const connector = item.createDiv({ cls: "fast-todos-indent-guide" });
        // Position each guide at its indent level
        connector.style.left = `${i * indentWidth + 4}px`;
      }
    }

    // Apply padding based on indent level (tighter spacing)
    item.style.paddingLeft = `${task.indent > 0 ? task.indent * 16 : 6}px`;

    const completeBg = item.createDiv({
      cls: "fast-todos-swipe-bg complete",
      text: "✓ Complete",
    });
    const editBg = item.createDiv({
      cls: "fast-todos-swipe-bg edit",
      text: "Edit ✎",
    });

    const contentEl = item.createDiv({ cls: "fast-todos-swipe-content" });

    const checkbox = contentEl.createEl("input", {
      type: "checkbox",
      cls: "fast-todos-checkbox",
    });
    checkbox.checked = task.completed;
    if (task.completed) checkbox.setAttribute("checked", "checked");
    checkbox.setAttribute("data-status", task.status);

    const textWrapper = contentEl.createDiv({ cls: "fast-todos-text-wrapper" });
    const textSpan = textWrapper.createSpan({ cls: "fast-todos-text", text: "" });
    if (task.completed) textSpan.addClass("fast-todos-completed");

    const parts = this.parseTextWithTags(task.cleanText);
    for (const part of parts) {
      if (part.type === "tag") {
        textSpan.createSpan({ cls: "fast-todos-tag", text: part.text });
      } else {
        textSpan.appendText(part.text);
      }
    }

    if (task.completed && task.completedDate) {
      textWrapper.createSpan({
        cls: "fast-todos-completion-stamp",
        text: `[COMPLETED: ${task.completedDate}]`,
      });
    }

    if (task.dueDate) {
      const today = moment().format("YYYY-MM-DD");
      const isOverdue = task.dueDate < today && !task.completed;
      const dueEl = contentEl.createSpan({
        cls: `fast-todos-due ${isOverdue ? "overdue" : ""}`,
        text: `📅 ${task.dueDate}`,
      });
    }

    if (task.priority !== "normal") {
      const pClass = `fast-todos-priority-${task.priority}`;
      const pLabel = task.priority === "high" ? "HIGH" : "LOW";
      const wrapper = contentEl.createSpan({
        cls: "fast-todos-priority-wrapper",
      });
      wrapper.createSpan({
        cls: `fast-todos-priority-badge ${pClass}`,
        text: pLabel,
      });
    }

    checkbox.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await this.cycleTaskStatus(task, file, item);
    };

    const actionGroup = contentEl.createDiv({ cls: "fast-todos-actions" });

    const linkBtn = actionGroup.createSpan({
      cls: "fast-todos-action-btn",
      text: "LINK",
    });
    const handleLinkClick = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.app.workspace
        .getLeaf(false)
        .openFile(file, { eState: { line: task.line } });
    };
    linkBtn.onclick = handleLinkClick;
    linkBtn.addEventListener("touchend", handleLinkClick, { passive: false });

    const editBtn = actionGroup.createSpan({
      cls: "fast-todos-action-btn",
      text: "EDIT",
    });
    const handleEditClick = (e?: Event) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      new TaskEditModal(this.app, task, async (result) => {
        const cached = FastTodosRenderer.taskCache.find(
          (t) => `${t.path}:${t.line}` === taskId,
        );
        if (cached) {
          cached.completed = result.completed;
          cached.cleanText = result.description;
          cached.priority = result.priority;
          cached.dueDate = result.dueDate;
        }
        await this.updateTask(file, task, result);

        (this.app.workspace as any).trigger("fast-todos:refresh-all");
      }).open();
    };
    editBtn.onclick = handleEditClick;
    editBtn.addEventListener("touchend", handleEditClick, { passive: false });

    this.setupSwipeGestures(
      item,
      contentEl,
      completeBg,
      editBg,
      task,
      file,
      taskId,
    );
    // Drag-and-drop disabled - user prefers swipe gestures only
    // this.setupDragAndDrop(item, task, file);

    item.onclick = (e) => {
      // If we clicked on a button or checkbox, don't change selection here as they have their own handlers
      // Actually, it's better to always select on click
      this.selectedTaskId = taskId;
      this.itemElements.forEach((el) => el.removeClass("is-selected"));
      item.addClass("is-selected");
    };
  }

  private parseTextWithTags(
    text: string,
  ): Array<{ type: "text" | "tag"; text: string }> {
    const result: Array<{ type: "text" | "tag"; text: string }> = [];
    const tagRegex = /(?:^|\s)(#[^\s\[\],.;!?]+)/g;
    let lastIndex = 0;
    let match;

    while ((match = tagRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push({ type: "text", text: text.slice(lastIndex, match.index) });
      }
      result.push({ type: "tag", text: match[1] });
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) {
      result.push({ type: "text", text: text.slice(lastIndex) });
    }

    if (result.length === 0) {
      result.push({ type: "text", text });
    }

    return result;
  }

  private setupDragAndDrop(item: HTMLElement, task: FastTask, file: TFile) {
    item.setAttribute("draggable", "true");

    item.addEventListener("dragstart", (e) => {
      item.addClass("dragging");
      e.dataTransfer?.setData(
        "text/plain",
        JSON.stringify({
          path: task.path,
          line: task.line,
          text: task.text,
        }),
      );
      e.dataTransfer!.effectAllowed = "move";
    });

    item.addEventListener("dragend", () => {
      item.removeClass("dragging");
      document.querySelectorAll(".fast-todos-item").forEach((el) => {
        el.removeClass("drag-over");
      });
    });

    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      const draggingEl = document.querySelector(".fast-todos-item.dragging");
      if (draggingEl && draggingEl !== item) {
        item.addClass("drag-over");
      }
    });

    item.addEventListener("dragleave", () => {
      item.removeClass("drag-over");
    });

    item.addEventListener("drop", async (e) => {
      e.preventDefault();
      item.removeClass("drag-over");

      const data = e.dataTransfer?.getData("text/plain");
      if (!data) return;

      try {
        const draggedTask = JSON.parse(data);
        if (draggedTask.path === task.path) {
          await this.reorderTasks(file, draggedTask.line, task.line);
        }
      } catch (err) {
        console.error("Drag and drop error:", err);
      }
    });
  }

  private async reorderTasks(file: TFile, fromLine: number, toLine: number) {
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");

      if (fromLine >= lines.length || toLine >= lines.length) return;

      const taskLine = lines[fromLine];
      lines.splice(fromLine, 1);
      const insertIndex = fromLine < toLine ? toLine : toLine;
      lines.splice(insertIndex, 0, taskLine);

      await this.app.vault.modify(file, lines.join("\n"));

      FastTodosRenderer.clearCache();
      this.lastRenderedHash = "";
      this.render();
    } catch (e) {
      console.error("Reorder failed:", e);
    }
  }

  private setupSwipeGestures(
    item: HTMLElement,
    contentEl: HTMLElement,
    completeBg: HTMLElement,
    editBg: HTMLElement,
    task: FastTask,
    file: TFile,
    taskId: string,
  ) {
    let startX = 0;
    let currentX = 0;
    let isDragging = false;
    let hapticTriggered = false;
    let touchStartedOnButton = false;
    const SWIPE_THRESHOLD = 80;
    const HAPTIC_THRESHOLD = 60;

    const onTouchStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target?.closest(".fast-todos-action-btn")) {
        touchStartedOnButton = true;
        return;
      }
      touchStartedOnButton = false;
      startX = e.touches[0].clientX;
      isDragging = true;
      hapticTriggered = false;
      item.addClass("swiping");
    };

    const onTouchMove = (e: TouchEvent) => {
      if (touchStartedOnButton) return;
      if (!isDragging) return;

      currentX = e.touches[0].clientX;
      const deltaX = currentX - startX;

      if (Math.abs(deltaX) > 10) {
        e.preventDefault();
      }

      const resistance = 0.6;
      const translateX = deltaX * resistance;
      contentEl.style.transform = `translateX(${translateX}px)`;

      if (deltaX > 0) {
        completeBg.addClass("active");
        editBg.removeClass("active");

        if (deltaX > HAPTIC_THRESHOLD && !hapticTriggered) {
          this.triggerHaptic();
          hapticTriggered = true;
        } else if (deltaX < HAPTIC_THRESHOLD) {
          hapticTriggered = false;
        }
      } else if (deltaX < 0) {
        completeBg.removeClass("active");
        editBg.addClass("active");

        if (Math.abs(deltaX) > HAPTIC_THRESHOLD && !hapticTriggered) {
          this.triggerHaptic();
          hapticTriggered = true;
        } else if (Math.abs(deltaX) < HAPTIC_THRESHOLD) {
          hapticTriggered = false;
        }
      }
    };

    const onTouchEnd = () => {
      if (touchStartedOnButton) {
        touchStartedOnButton = false;
        return;
      }
      if (!isDragging) return;
      isDragging = false;
      item.removeClass("swiping");

      const deltaX = currentX - startX;

      if (deltaX > SWIPE_THRESHOLD) {
        this.triggerHaptic();
        this.handleSwipeComplete(task, file, taskId, item);
      } else if (deltaX < -SWIPE_THRESHOLD) {
        this.triggerHaptic();
        this.handleSwipeEdit(task, file, taskId);
      }

      contentEl.style.transform = "";
      completeBg.removeClass("active");
      editBg.removeClass("active");
      hapticTriggered = false;
    };

    item.addEventListener("touchstart", onTouchStart, { passive: true });
    item.addEventListener("touchmove", onTouchMove, { passive: false });
    item.addEventListener("touchend", onTouchEnd, { passive: true });
    item.addEventListener("touchcancel", onTouchEnd, { passive: true });
  }

  private triggerHaptic() {
    if (navigator.vibrate) {
      navigator.vibrate(10);
    }
  }

  private async handleSwipeComplete(
    task: FastTask,
    file: TFile,
    taskId: string,
    item: HTMLElement,
  ) {
    const newState = !task.completed;
    task.completed = newState;

    if (newState) {
      this.startCountdown(taskId, item, task);
    } else {
      this.applyVisualDone(item, false);
      this.activeCountdowns.delete(taskId);
      const existingCountdown = item.querySelector(".fast-todos-countdown");
      if (existingCountdown) existingCountdown.remove();
    }

    const cached = FastTodosRenderer.taskCache.find(
      (t) => `${t.path}:${t.line}` === taskId,
    );
    if (cached) {
      cached.completed = newState;
      cached.status = newState ? "x" : " ";
    }

    await this.setTaskStatus(file, task, newState ? "x" : " ");
  }

  private handleSwipeEdit(task: FastTask, file: TFile, taskId: string) {
    new TaskEditModal(this.app, task, async (result) => {
      const cached = FastTodosRenderer.taskCache.find(
        (t) => `${t.path}:${t.line}` === taskId,
      );
      if (cached) {
        cached.completed = result.completed;
        cached.cleanText = result.description;
        cached.priority = result.priority;
        cached.dueDate = result.dueDate;
      }
      await this.updateTask(file, task, result);
      (this.app.workspace as any).trigger("fast-todos:refresh-all");
    }).open();
  }

  async updateTask(
    file: TFile,
    task: FastTask,
    result: {
      description: string;
      completed: boolean;
      priority: "high" | "normal" | "low";
      dueDate?: string;
    },
  ) {
    try {
      const content = await this.app.vault.read(file);
      const lines = content.split("\n");
      if (task.line >= lines.length) return;

      let line = lines[task.line];
      if (!line) return;

      const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX\-]\]\s*)(.*)/);
      if (!taskMatch) return;

      const prefix = taskMatch[1];
      const basePrefix = prefix.replace(
        /\[.\]/,
        result.completed ? "[x]" : "[ ]",
      );

      let cleanDesc = result.description
        .replace(
          /\[(?:priority|completed|completion|created|due):+[^\]]+\]/gi,
          "",
        )
        .trim();

      if (result.priority && result.priority !== "normal") {
        cleanDesc += ` [priority: ${result.priority}]`;
      }
      if (result.dueDate) {
        cleanDesc += ` [due: ${result.dueDate}]`;
      }

      let finalLine = basePrefix + cleanDesc;
      if (result.completed) {
        const now = moment().format("YYYY-MM-DD");
        if (!finalLine.includes("[completed:")) {
          finalLine += ` [completed: ${now}]`;
        }
      } else {
        finalLine = finalLine
          .replace(/\[(?:completed|completion):\s*[^\]]*\]/gi, "")
          .trimEnd();
      }

      await this.plugin.safeModifyLine(file, task.line, finalLine.trimEnd());
    } catch (e) {
      console.error("Update Task failed:", e);
    }
  }

  async toggleTask(file: TFile, task: FastTask) {
    await this.setTaskStatus(file, task, task.completed ? "x" : " ");
  }
}

export class CompletionStampWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "fast-todos-completion-stamp";
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return false;
  }
}

class EditButtonWidget extends WidgetType {
  constructor(
    private app: App,
    private taskLine: string,
    private lineNum: number,
    private filePath: string,
    private plugin: any,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.style.pointerEvents = "none"; // Let clicks pass through

    const span = document.createElement("span");
    span.className = "fast-todos-inline-edit";
    span.textContent = "EDIT";
    span.style.marginLeft = "12px";
    span.style.cursor = "pointer";
    span.style.pointerEvents = "auto"; // Re-enable pointer events for the button itself

    span.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const pos = view.posAtDOM(span);
      const line = view.state.doc.lineAt(pos);
      const text = line.text;
      const lineNum = line.number - 1;

      const file = this.app.vault.getAbstractFileByPath(this.filePath);
      if (file instanceof TFile) {
        const match = text.match(/^(\s*[-*+\d\.\s]*\s*\[([ xX\-])\])(.*)/);
        if (match) {
          const isCompleted = match[2].toLowerCase() === "x";
          const task = this.plugin.parseTaskLine(
            text,
            lineNum,
            this.filePath,
            isCompleted,
          );

          new this.plugin.TaskEditModalClass(
            this.app,
            task,
            async (result: any) => {
              await this.plugin.handleTaskUpdate(file, task, result);
            },
          ).open();
        } else {
          console.log("Fast Todos: Line no longer matches task pattern", text);
        }
      }
    };

    wrapper.appendChild(span);
    return wrapper;
  }

  ignoreEvent(event: Event) {
    // Allow mousedown events to propagate so cursor positioning works correctly
    // Only the onclick handler on the span will handle the actual edit action
    if (event.type === 'mousedown') {
      return false;
    }
    return true;
  }
}

export function editButtonPlugin(app: App, plugin: any) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();
        const file = app.workspace.getActiveFile();
        if (!file) return Decoration.none;

        for (let { from, to } of view.visibleRanges) {
          for (let pos = from; pos <= to;) {
            const line = view.state.doc.lineAt(pos);
            const text = line.text;

            const tagMatch = text.match(
              /\[(?:completed|completion):\s*[^\]]*\]/i,
            );
            if (tagMatch && tagMatch.index !== undefined) {
              builder.add(
                line.from + tagMatch.index,
                line.from + tagMatch.index + tagMatch[0].length,
                Decoration.replace({
                  widget: new CompletionStampWidget(tagMatch[0]),
                }),
              );
            }

            if (text.match(/^\s*[-*+\d\.\s]*\s*\[[ xX\-]\]/)) {
              builder.add(
                line.to,
                line.to,
                Decoration.widget({
                  widget: new EditButtonWidget(
                    app,
                    text,
                    line.number - 1,
                    file.path,
                    plugin,
                  ),
                  side: 1,
                }),
              );
            }
            pos = line.to + 1;
          }
        }
        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
