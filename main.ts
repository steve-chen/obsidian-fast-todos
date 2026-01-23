import { App, MarkdownRenderChild, Plugin, TFile, moment, Editor, MarkdownView, Modal, Setting, MarkdownPostProcessorContext } from 'obsidian';
import { EditorView, Decoration, DecorationSet, WidgetType, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

interface FastTask {
    text: string;
    completed: boolean;
    line: number;
    path: string;
    completedDate?: string;
    cleanText: string;
    priority: 'high' | 'normal' | 'low';
}

export default class FastTodos extends Plugin {
    public lastInternalUpdate: number = 0;
    private completionTimer: NodeJS.Timeout | null = null;
    private completionRegex = /\[(?:completed|completion):\s*[^\]]*\]/i;
    public TaskEditModalClass = TaskEditModal;

    async onload() {
        console.log('Loading Fast Todos');

        this.registerMarkdownCodeBlockProcessor('todos', async (source, el, ctx) => {
            const child = new FastTodosRenderer(el, this.app, source, ctx.sourcePath, this);
            ctx.addChild(child);
        });

        this.registerEvent(
            this.app.workspace.on('editor-change', (editor: Editor) => {
                if (this.completionTimer) clearTimeout(this.completionTimer);
                this.completionTimer = setTimeout(() => {
                    const lineCount = editor.lineCount();
                    let changesMade = false;
                    const activeFile = this.app.workspace.getActiveFile();

                    for (let i = 0; i < lineCount; i++) {
                        const line = editor.getLine(i);
                        const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[([ xX])\]\s*)(.*)/);
                        if (!taskMatch) continue;

                        const isDone = taskMatch[2].toLowerCase() === 'x';
                        const hasTag = this.completionRegex.test(line);

                        // BROADCAST status change instantly to renderers
                        if (activeFile) {
                            const taskId = `${activeFile.path}:${i}`;
                            (this.app.workspace as any).trigger('fast-todos:status-change', taskId, isDone);
                        }

                        if (isDone && !hasTag) {
                            const now = moment().format('YYYY-MM-DD');
                            const newLine = line.trimEnd() + ` [completed: ${now}]`;
                            if (line !== newLine) {
                                editor.setLine(i, newLine);
                                changesMade = true;
                            }
                        } else if (!isDone && hasTag) {
                            const newLine = line.replace(/\s*\[(?:completed|completion):\s*[^\]]*\]/gi, '').trimEnd();
                            if (line !== newLine) {
                                editor.setLine(i, newLine);
                                changesMade = true;
                            }
                        }
                    }

                    if (changesMade) {
                        this.lastInternalUpdate = Date.now();
                        FastTodosRenderer.clearCache();
                    }
                }, 500);
            })
        );

        this.registerMarkdownPostProcessor((el, ctx) => {
            this.postProcessReadingModeTasks(el, ctx);
        });

        this.registerEditorExtension(editButtonPlugin(this.app, this));
    }






    private postProcessReadingModeTasks(el: HTMLElement, ctx: MarkdownPostProcessorContext) {
        const taskItems = el.querySelectorAll('.task-list-item');
        if (taskItems.length === 0) return;

        taskItems.forEach((item) => {
            if ((item as HTMLElement).querySelector('.fast-todos-inline-edit')) return;

            const editBtn = item.createSpan({ cls: 'fast-todos-inline-edit', text: 'EDIT' });
            editBtn.onclick = async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const section = ctx.getSectionInfo(el);
                if (!section) return;

                const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath) as TFile;
                if (!file || !(file instanceof TFile)) return;

                const content = await this.app.vault.read(file);
                const lines = content.split('\n');

                // Heuristic to find the exact line matching this task
                // We limit search to the section range
                // We purposefully don't use the DOM text for exact matching because of markdown rendering differences
                // Instead, we find the Nth task in the block that corresponds to the Nth task item in the DOM?
                // This is risky if there are nested lists.

                // Strategy: 
                // 1. Get all task items in this block (el)
                // 2. Find the index of the clicked item among them
                // 3. Scan the source lines in the section and find the corresponding Nth task string

                const allTasksInBlock = Array.from(el.querySelectorAll('.task-list-item'));
                const index = allTasksInBlock.indexOf(item);

                if (index === -1) return;

                let taskCount = 0;
                let targetTask: FastTask | null = null;

                for (let i = section.lineStart; i <= section.lineEnd; i++) {
                    const line = lines[i];
                    if (!line) continue;

                    if (line.match(/^\s*[-*+\d\.\s]*\s*\[[ xX]\]/)) {
                        if (taskCount === index) {
                            const taskStatusMatch = line.match(/\[([ xX])\]/);
                            const isCompleted = taskStatusMatch ? (taskStatusMatch[1].toLowerCase() === 'x') : false;
                            targetTask = this.parseTaskLine(line, i, file.path, isCompleted);
                            break;
                        }
                        taskCount++;
                    }
                }

                if (targetTask) {
                    new TaskEditModal(this.app, targetTask, async (result) => {
                        await this.handleTaskUpdate(file, targetTask!, result);
                        // Trigger internal refresh if needed, though file change usually triggers it
                        // (this.app.workspace as any).trigger('fast-todos:refresh-all');
                    }).open();
                }
            };
        });
    }

    private parseTaskLine(line: string, lineNum: number, path: string, isCompleted: boolean): FastTask {
        const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX]\])(.*)/);
        const rawContent = taskMatch ? taskMatch[2] : line;

        const completedMatch = rawContent.match(/\[(completed|completion):+\s*([^\]]+)\]/i);
        const priorityMatch = rawContent.match(/\[priority:+\s*(high|normal|low)\]/i);

        let displayDescription = rawContent.replace(/\[(created|completed|completion|due|priority):+[^\]]+\]/gi, '').trim();

        return {
            text: line,
            cleanText: displayDescription || "(No Description)",
            completed: isCompleted,
            line: lineNum,
            path,
            completedDate: completedMatch ? completedMatch[2] : undefined,
            priority: priorityMatch ? priorityMatch[1].toLowerCase() as any : 'normal'
        };
    }

    async handleTaskUpdate(file: TFile, task: FastTask, result: { description: string, completed: boolean, priority: 'high' | 'normal' | 'low' }) {
        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            if (task.line >= lines.length) return;

            let line = lines[task.line];
            if (!line) return;

            const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX]\]\s*)(.*)/);
            if (!taskMatch) return;

            const prefix = taskMatch[1];
            const basePrefix = prefix.replace(/\[.\]/, result.completed ? '[x]' : '[ ]');

            let cleanDesc = result.description.replace(/\[(?:priority|completed|completion|created|due):+[^\]]+\]/gi, '').trim();

            if (result.priority && result.priority !== 'normal') {
                cleanDesc += ` [priority: ${result.priority}]`;
            }

            let finalLine = basePrefix + cleanDesc;
            if (result.completed) {
                const now = moment().format('YYYY-MM-DD');
                // Check if completed tag existed? This simple logic just appends if completed.
                // To be robust, we should arguably check if we need to update an existing completed tag or add one.
                // But following the Renderer's logic:
                if (!line.match(/\[completed:/)) {
                    finalLine += ` [completed: ${now}]`;
                }
            } else {
                // Remove completed tag if un-completing
                finalLine = finalLine.replace(/\[(?:completed|completion):\s*[^\]]*\]/gi, '').trimEnd();
            }

            await this.safeModifyLine(file, task.line, finalLine.trimEnd());
        } catch (e) {
            console.error("Update Task failed:", e);
        }
    }

    async safeModifyLine(file: TFile, lineNum: number, newLine: string) {
        this.lastInternalUpdate = Date.now();
        let editorUsed = false;

        this.app.workspace.iterateAllLeaves(leaf => {
            if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) {
                leaf.view.editor.setLine(lineNum, newLine);
                editorUsed = true;
            }
        });

        if (!editorUsed) {
            await this.app.vault.process(file, (data) => {
                const lines = data.split('\n');
                lines[lineNum] = newLine;
                return lines.join('\n');
            });
        }
    }
}

class TaskEditModal extends Modal {
    result: { description: string, completed: boolean, priority: 'high' | 'normal' | 'low' };

    constructor(app: App, public task: FastTask, public onSubmit: (result: { description: string, completed: boolean, priority: 'high' | 'normal' | 'low' }) => void) {
        super(app);
        this.result = {
            description: task.cleanText === "(No Description)" ? "" : task.cleanText,
            completed: task.completed,
            priority: task.priority
        };
    }

    onOpen() {
        const { contentEl } = this;
        this.containerEl.addClass('fast-todos-modal');
        contentEl.createEl('h2', { text: 'Edit Task' });

        const descContainer = contentEl.createDiv({ cls: 'fast-modal-description' });
        descContainer.createEl('label', { text: 'Description', cls: 'fast-modal-label' });
        const textarea = descContainer.createEl('textarea', { placeholder: 'Task description...' });
        textarea.value = this.result.description;
        textarea.oninput = (e) => this.result.description = (e.target as HTMLTextAreaElement).value;

        new Setting(contentEl)
            .setName('Completed Status')
            .addToggle(toggle => toggle.setValue(this.result.completed).onChange(value => this.result.completed = value));

        new Setting(contentEl)
            .setName('Priority')
            .addDropdown(dropdown => dropdown
                .addOption('high', 'High')
                .addOption('normal', 'Normal')
                .addOption('low', 'Low')
                .setValue(this.result.priority)
                .onChange(value => this.result.priority = value as any));

        new Setting(contentEl)
            .addButton(btn => btn.setButtonText('Save').setCta().onClick(() => {
                this.close();
                this.onSubmit(this.result);
            }));
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
    }
}

class FastTodosRenderer extends MarkdownRenderChild {
    private static taskCache: FastTask[] = [];
    private static lastScanTime: number = 0;
    private lastRenderedHash: string = "";
    private completionRegex = /\[(?:completed|completion):\s*[^\]]*\]/gi;
    private refreshTimer: NodeJS.Timeout | null = null;
    private activeCountdowns: Set<string> = new Set();

    constructor(public containerEl: HTMLElement, public app: App, public source: string, public sourcePath: string, public plugin: FastTodos) {
        super(containerEl);
    }

    static clearCache() {
        FastTodosRenderer.lastScanTime = 0;
        FastTodosRenderer.taskCache = [];
    }

    async onload() {
        this.render();

        // Listen for internal BROADCAST status changes
        this.registerEvent((this.app.workspace as any).on('fast-todos:status-change', (taskId: string, isDone: boolean) => {
            const itemEl = this.containerEl.querySelector(`[data-task-id="${taskId}"]`) as HTMLElement;
            const taskInView = FastTodosRenderer.taskCache.find(t => `${t.path}:${t.line}` === taskId);

            if (itemEl && taskInView) {
                if (isDone) {
                    // SILENT UPDATE: Mark as done but NO countdown for Markdown actions
                    taskInView.completed = true;
                    this.applyVisualDone(itemEl, true);
                } else {
                    // Uncheck: remove strikes and countdowns
                    taskInView.completed = false;
                    this.activeCountdowns.delete(taskId);
                    this.applyVisualDone(itemEl, false);
                    const countdown = itemEl.querySelector('.fast-todos-countdown');
                    if (countdown) countdown.remove();
                }
            }
        }));

        this.registerEvent(this.app.metadataCache.on('changed', (file) => {
            if (this.activeCountdowns.size > 0) return;

            // If we just updated internally, wait a bit longer to let the filesystem settle
            const delay = Date.now() - this.plugin.lastInternalUpdate < 3000 ? 1000 : 500;

            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => {
                FastTodosRenderer.clearCache();
                this.render();
            }, delay);
        }));

        // Listen for GLOBAL refresh broadcast
        this.registerEvent((this.app.workspace as any).on('fast-todos:refresh-all', () => {
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => {
                FastTodosRenderer.clearCache();
                this.lastRenderedHash = ""; // Force re-render
                this.render();
            }, 400); // Wait for Obsidian metadata cache to catch up
        }));
    }

    private applyVisualDone(itemEl: HTMLElement, isDone: boolean) {
        const checkbox = itemEl.querySelector('.fast-todos-checkbox') as HTMLInputElement;
        const textSpan = itemEl.querySelector('.fast-todos-text') as HTMLElement;
        if (checkbox) {
            checkbox.checked = isDone;
            if (isDone) checkbox.setAttribute('checked', 'checked');
            else checkbox.removeAttribute('checked');
        }
        if (textSpan) {
            if (isDone) textSpan.classList.add('fast-todos-completed');
            else textSpan.classList.remove('fast-todos-completed');
        }
    }

    async render() {
        if (!this.containerEl) return;
        const tasks = await this.getTasks();
        const config = this.parseConfig(this.source);
        const today = moment().format('YYYY-MM-DD');

        // Apply all filters (Lines are AND-ed together)
        let filteredTasks = tasks.filter(t => {
            return config.filters.every(filter => filter(t));
        });

        // Handle Sorting
        if (config.sortBy) {
            filteredTasks.sort((a, b) => {
                if (config.sortBy === 'priority') {
                    const weight: any = { high: 3, normal: 2, low: 1 };
                    const wa = weight[a.priority] || 2;
                    const wb = weight[b.priority] || 2;
                    return wb - wa;
                }
                if (config.sortBy === 'path') return (a.path || "").localeCompare(b.path || "");
                if (config.sortBy === 'description' || config.sortBy === 'alphabet') return (a.cleanText || "").localeCompare(b.cleanText || "");
                if (config.sortBy === 'date') return (a.completedDate || "").localeCompare(b.completedDate || "");
                return 0;
            });
        }

        // Handle Limit
        if (config.limit !== undefined) {
            filteredTasks = filteredTasks.slice(0, config.limit);
        }

        // Create a hash to avoid unnecessary re-renders. Include priority.
        const currentHash = JSON.stringify(filteredTasks.map(t => ({
            p: t.path,
            l: t.line,
            c: t.completed,
            t: t.cleanText,
            pr: t.priority
        })));

        if (currentHash === this.lastRenderedHash) return;
        this.lastRenderedHash = currentHash;

        try {
            this.containerEl.empty();
            this.containerEl.addClass('fast-todos-container');

            if (filteredTasks.length === 0) {
                this.containerEl.createDiv({ text: 'No matching tasks.', cls: 'fast-todos-empty' });
                return;
            }

            const groups = this.groupTasks(filteredTasks, config.groupBy);
            for (const [groupName, fileTasks] of Object.entries(groups)) {
                if (!fileTasks || fileTasks.length === 0) continue;

                const groupWrap = this.containerEl.createDiv({ cls: 'fast-todos-group' });
                const header = groupWrap.createDiv({ cls: 'fast-todos-header' });

                const firstTask = fileTasks[0];
                const possibleFile = this.app.vault.getAbstractFileByPath(firstTask.path) as TFile;
                const link = header.createEl('a', { text: groupName, cls: 'fast-todos-file-link' });
                if (possibleFile && groupName.includes(possibleFile.basename)) {
                    link.onclick = () => this.app.workspace.getLeaf(false).openFile(possibleFile);
                }

                const list = groupWrap.createDiv({ cls: 'fast-todos-list' });
                for (const task of fileTasks) {
                    const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
                    if (file) {
                        this.renderTask(list, task, file);
                    }
                }
            }
        } catch (e) {
            console.error("Fast Todos Render Error:", e);
            this.containerEl.createDiv({ text: "Error rendering tasks. Check console.", cls: "fast-todos-empty" });
        }
    }

    async getTasks(): Promise<FastTask[]> {
        const now = Date.now();
        if (FastTodosRenderer.taskCache.length > 0 && (now - FastTodosRenderer.lastScanTime < 10000)) {
            return FastTodosRenderer.taskCache;
        }

        const allFiles = this.app.vault.getMarkdownFiles();
        const tasks: FastTask[] = [];

        for (const file of allFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache || !cache.listItems) continue;

            const content = await this.app.vault.cachedRead(file);
            const lines = content.split('\n');

            for (const item of cache.listItems) {
                if (item.task) {
                    const lineText = lines[item.position.start.line];
                    if (!lineText) continue;

                    const taskStatusMatch = lineText.match(/\[([ xX])\]/);
                    const isCompleted = taskStatusMatch ? (taskStatusMatch[1].toLowerCase() === 'x') : (item.task === 'x' || item.task === 'X');

                    tasks.push(this.parseTaskLine(lineText, item.position.start.line, file.path, isCompleted));
                }
            }
        }

        FastTodosRenderer.taskCache = tasks;
        FastTodosRenderer.lastScanTime = now;
        return tasks;
    }

    parseTaskLine(line: string, lineNum: number, path: string, isCompleted: boolean): FastTask {
        const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX]\])(.*)/);
        const rawContent = taskMatch ? taskMatch[2] : line;

        const completedMatch = rawContent.match(/\[(completed|completion):+\s*([^\]]+)\]/i);
        const priorityMatch = rawContent.match(/\[priority:+\s*(high|normal|low)\]/i);

        let displayDescription = rawContent.replace(/\[(created|completed|completion|due|priority):+[^\]]+\]/gi, '').trim();

        return {
            text: line,
            cleanText: displayDescription || "(No Description)",
            completed: isCompleted,
            line: lineNum,
            path,
            completedDate: completedMatch ? completedMatch[2] : undefined,
            priority: priorityMatch ? priorityMatch[1].toLowerCase() as any : 'normal'
        };
    }

    evaluateAtom(atom: string, task: FastTask): boolean {
        const low = atom.toLowerCase().trim();
        const today = moment().format('YYYY-MM-DD');

        if (low === 'not done') {
            return !task.completed || this.activeCountdowns.has(`${task.path}:${task.line}`);
        }
        if (low === 'done' || low === 'is done') {
            return task.completed;
        }
        if (low === 'done today') {
            return task.completed && task.completedDate === today;
        }
        if (low.startsWith('path includes ')) {
            const p = low.replace('path includes ', '').trim();
            return task.path.toLowerCase().includes(p);
        }
        if (low.startsWith('tag includes ')) {
            const t = low.replace('tag includes ', '').trim();
            return task.text.toLowerCase().includes(t);
        }
        if (low.startsWith('priority is ')) {
            const p = low.replace('priority is ', '').trim();
            return task.priority === p;
        }
        if (low.startsWith('priority is not ')) {
            const p = low.replace('priority is not ', '').trim();
            return task.priority !== p;
        }
        return true;
    }

    parseConfig(source: string) {
        const lines = source.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const config = {
            filters: [] as ((t: FastTask) => boolean)[],
            limit: undefined as number | undefined,
            groupBy: '',
            sortBy: ''
        };

        for (const line of lines) {
            const lowLine = line.toLowerCase();

            // Meta configurations
            if (lowLine.startsWith('limit')) {
                const num = parseInt(lowLine.replace('limit', '').trim());
                if (!isNaN(num)) config.limit = num;
                continue;
            }
            if (lowLine.startsWith('group by')) {
                config.groupBy = lowLine.replace('group by', '').trim();
                continue;
            }
            if (lowLine.startsWith('sort by')) {
                config.sortBy = lowLine.replace('sort by', '').trim();
                continue;
            }

            // Boolean Logic Parser (Implicit AND between lines, explicit AND/OR on line)
            // Split by OR first (OR has lower precedence than AND)
            const orParts = line.split(/\s+OR\s+/);
            config.filters.push((task: FastTask) => {
                return orParts.some(orPart => {
                    // Split each OR segment by AND
                    const andParts = orPart.split(/\s+AND\s+/);
                    return andParts.every(andPart => this.evaluateAtom(andPart, task));
                });
            });
        }
        return config;
    }

    groupTasks(tasks: FastTask[], groupBy: string) {
        const groups: Record<string, FastTask[]> = {};
        for (const task of tasks) {
            let key = task.path.split('/').pop() || task.path;
            if (groupBy === 'path') key = task.path;
            if (key.endsWith('.md')) key = key.slice(0, -3);

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

        const countdownSpan = itemEl.createSpan({ cls: 'fast-todos-countdown', text: '5' });

        let count = 5;
        const interval = setInterval(() => {
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

                // FORCE rendering by clearing the hash shield
                this.lastRenderedHash = "";
                FastTodosRenderer.clearCache();
                this.render();
            }
        }, 1000);
    }

    renderTask(parent: HTMLElement, task: FastTask, file: TFile) {
        const taskId = `${task.path}:${task.line}`;
        const item = parent.createDiv({ cls: 'fast-todos-item' });
        item.setAttribute('data-task-id', taskId);

        const checkbox = item.createEl('input', { type: 'checkbox', cls: 'fast-todos-checkbox' });
        checkbox.checked = task.completed;
        if (task.completed) checkbox.setAttribute('checked', 'checked');

        const textSpan = item.createSpan({ cls: 'fast-todos-text', text: '' });
        if (task.completed) textSpan.addClass('fast-todos-completed');

        const parts = task.cleanText.split(/(#[^\s,]+)/g);
        for (const part of parts) {
            if (part && part.startsWith('#')) textSpan.createSpan({ cls: 'fast-todos-tag', text: part });
            else textSpan.appendText(part);
        }

        if (task.priority !== 'normal') {
            const pClass = `fast-todos-priority-${task.priority}`;
            const pLabel = task.priority === 'high' ? 'HIGH' : 'LOW';
            item.createSpan({ cls: `fast-todos-priority-badge ${pClass}`, text: pLabel });
        }

        checkbox.onclick = async (e) => {
            const newState = !task.completed;
            task.completed = newState;

            if (newState) {
                this.startCountdown(taskId, item, task);
            } else {
                this.applyVisualDone(item, false);
                this.activeCountdowns.delete(taskId);
                const existingCountdown = item.querySelector('.fast-todos-countdown');
                if (existingCountdown) existingCountdown.remove();
            }

            const cached = FastTodosRenderer.taskCache.find(t => `${t.path}:${t.line}` === taskId);
            if (cached) cached.completed = newState;

            await this.toggleTask(file, task);
        };

        const actionGroup = item.createDiv({ cls: 'fast-todos-actions' });
        if (task.completed && task.completedDate) {
            actionGroup.createSpan({ cls: 'fast-todos-completed-date', text: ` ✅ ${task.completedDate}` });
        }

        const linkBtn = actionGroup.createSpan({ cls: 'fast-todos-action-btn', text: 'LINK' });
        linkBtn.onclick = (e) => {
            e.preventDefault();
            this.app.workspace.getLeaf(false).openFile(file, { eState: { line: task.line } });
        };

        const editBtn = actionGroup.createSpan({ cls: 'fast-todos-action-btn', text: 'EDIT' });
        editBtn.onclick = () => {
            new TaskEditModal(this.app, task, async (result) => {
                const cached = FastTodosRenderer.taskCache.find(t => `${t.path}:${t.line}` === taskId);
                if (cached) {
                    cached.completed = result.completed;
                    cached.cleanText = result.description;
                    cached.priority = result.priority;
                }
                await this.updateTask(file, task, result);

                // Broadcase refresh to all blocks
                (this.app.workspace as any).trigger('fast-todos:refresh-all');
            }).open();
        };
    }

    async updateTask(file: TFile, task: FastTask, result: { description: string, completed: boolean, priority: 'high' | 'normal' | 'low' }) {
        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            if (task.line >= lines.length) return;

            let line = lines[task.line];
            if (!line) return;

            const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX]\]\s*)(.*)/);
            if (!taskMatch) return;

            const prefix = taskMatch[1];
            const basePrefix = prefix.replace(/\[.\]/, result.completed ? '[x]' : '[ ]');

            // Strip known metadata tags before re-adding
            let cleanDesc = result.description.replace(/\[(?:priority|completed|completion|created|due):+[^\]]+\]/gi, '').trim();

            if (result.priority && result.priority !== 'normal') {
                cleanDesc += ` [priority: ${result.priority}]`;
            }

            let finalLine = basePrefix + cleanDesc;
            if (result.completed) {
                const now = moment().format('YYYY-MM-DD');
                finalLine += ` [completed: ${now}]`;
            }

            await this.plugin.safeModifyLine(file, task.line, finalLine.trimEnd());
        } catch (e) {
            console.error("Update Task failed:", e);
        }
    }

    async toggleTask(file: TFile, task: FastTask) {
        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            if (task.line >= lines.length) return;

            let line = lines[task.line];
            if (!line) return;

            const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX]\]\s*)(.*)/);
            if (!taskMatch) return;

            const prefix = taskMatch[1];
            const rawContent = taskMatch[2];
            const now = moment().format('YYYY-MM-DD');

            const basePrefix = prefix.replace(/\[.\]/, task.completed ? '[x]' : '[ ]');

            // Strip completion tag, but leave priority alone (it's already in the rawContent)
            const cleanContent = rawContent.replace(this.completionRegex, '').trim();

            let finalLine = basePrefix + cleanContent;
            if (task.completed) {
                finalLine += ` [completed: ${now}]`;
            }
            await this.plugin.safeModifyLine(file, task.line, finalLine.trimEnd());
        } catch (e) {
            console.error("Toggle Task failed:", e);
        }
    }
}


export class EditButtonWidget extends WidgetType {
    constructor(private app: App, private taskLine: string, private lineNum: number, private filePath: string, private plugin: any) {
        super();
    }

    toDOM(view: EditorView): HTMLElement {
        const span = document.createElement("span");
        span.className = "fast-todos-inline-edit";
        span.textContent = "EDIT";
        span.style.marginLeft = "auto";
        span.style.cursor = "pointer";

        span.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Get dynamic position from view
            const pos = view.posAtDOM(span);
            const line = view.state.doc.lineAt(pos);
            const text = line.text;
            const lineNum = line.number - 1; // 0-indexed for Obsidian API

            const file = this.app.vault.getAbstractFileByPath(this.filePath);
            if (file instanceof TFile) {
                // Parse current text
                const match = text.match(/^(\s*[-*+\d\.\s]*\s*\[([ xX])\])(.*)/);
                if (match) {
                    const isCompleted = match[2].toLowerCase() === 'x';
                    const task = this.plugin.parseTaskLine(text, lineNum, this.filePath, isCompleted);

                    new (this.plugin.TaskEditModalClass)(this.app, task, async (result: any) => {
                        await this.plugin.handleTaskUpdate(file, task, result);
                    }).open();
                } else {
                    console.log("Fast Todos: Line no longer matches task pattern", text);
                }
            }
        };
        return span;
    }

    ignoreEvent() { return true; }
}

export function editButtonPlugin(app: App, plugin: any) {
    return ViewPlugin.fromClass(class {
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

                    // Regex for task
                    if (text.match(/^\s*[-*+\d\.\s]*\s*\[[ xX]\]/)) {
                        // Add widget at the end of the line
                        builder.add(line.to, line.to, Decoration.widget({
                            widget: new EditButtonWidget(app, text, line.number - 1, file.path, plugin),
                            side: 1
                        }));
                    }
                    pos = line.to + 1;
                }
            }
            return builder.finish();
        }
    }, {
        decorations: v => v.decorations
    });
}
