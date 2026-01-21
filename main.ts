import { App, MarkdownRenderChild, Plugin, TFile, moment, Editor, MarkdownView, Modal, Setting } from 'obsidian';

interface FastTask {
    text: string;
    completed: boolean;
    line: number;
    path: string;
    completedDate?: string;
    cleanText: string;
}

export default class FastTodos extends Plugin {
    public lastInternalUpdate: number = 0;
    private completionTimer: NodeJS.Timeout | null = null;
    private completionRegex = /\[(?:completed|completion):\s*[^\]]*\]/i;

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
    result: { description: string, completed: boolean };

    constructor(app: App, public task: FastTask, public onSubmit: (result: { description: string, completed: boolean }) => void) {
        super(app);
        this.result = {
            description: task.cleanText === "(No Description)" ? "" : task.cleanText,
            completed: task.completed
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
            if (Date.now() - this.plugin.lastInternalUpdate < 1500) return;

            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => {
                FastTodosRenderer.clearCache();
                this.render();
            }, 800);
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
                if (config.sortBy === 'path') return a.path.localeCompare(b.path);
                if (config.sortBy === 'description' || config.sortBy === 'alphabet') return a.cleanText.localeCompare(b.cleanText);
                if (config.sortBy === 'date') return (a.completedDate || "").localeCompare(b.completedDate || "");
                return 0;
            });
        }

        // Handle Limit
        if (config.limit !== undefined) {
            filteredTasks = filteredTasks.slice(0, config.limit);
        }

        const currentHash = JSON.stringify(filteredTasks.map(t => ({ p: t.path, l: t.line, c: t.completed, t: t.cleanText })));
        if (currentHash === this.lastRenderedHash) return;
        this.lastRenderedHash = currentHash;

        this.containerEl.empty();
        this.containerEl.addClass('fast-todos-container');

        if (filteredTasks.length === 0) {
            this.containerEl.createDiv({ text: 'No matching tasks.', cls: 'fast-todos-empty' });
            return;
        }

        const groups = this.groupTasks(filteredTasks, config.groupBy);
        for (const [groupName, fileTasks] of Object.entries(groups)) {
            const groupWrap = this.containerEl.createDiv({ cls: 'fast-todos-group' });
            const header = groupWrap.createDiv({ cls: 'fast-todos-header' });

            const possibleFile = this.app.vault.getAbstractFileByPath(fileTasks[0].path) as TFile;
            const link = header.createEl('a', { text: groupName, cls: 'fast-todos-file-link' });
            if (possibleFile && groupName.includes(possibleFile.basename)) {
                link.onclick = () => this.app.workspace.getLeaf(false).openFile(possibleFile);
            }

            const list = groupWrap.createDiv({ cls: 'fast-todos-list' });
            for (const task of fileTasks) {
                const file = this.app.vault.getAbstractFileByPath(task.path) as TFile;
                if (file) this.renderTask(list, task, file);
            }
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
        let displayDescription = rawContent.replace(/\[(created|completed|completion|due|priority):+[^\]]+\]/gi, '').trim();

        return {
            text: line,
            cleanText: displayDescription || "(No Description)",
            completed: isCompleted,
            line: lineNum,
            path,
            completedDate: completedMatch ? completedMatch[2] : undefined
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
                }
                await this.updateTask(file, task, result);
                this.render();
            }).open();
        };
    }

    async updateTask(file: TFile, task: FastTask, result: { description: string, completed: boolean }) {
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let line = lines[task.line];
        const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX]\]\s*)(.*)/);
        if (!taskMatch) return;

        const prefix = taskMatch[1];
        const basePrefix = prefix.replace(/\[.\]/, result.completed ? '[x]' : '[ ]');
        let finalLine = basePrefix + result.description.trim();
        if (result.completed) {
            const now = moment().format('YYYY-MM-DD');
            finalLine += ` [completed: ${now}]`;
        }
        await this.plugin.safeModifyLine(file, task.line, finalLine.trimEnd());
    }

    async toggleTask(file: TFile, task: FastTask) {
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let line = lines[task.line];
        const taskMatch = line.match(/^(\s*[-*+\d\.\s]*\s*\[[ xX]\]\s*)(.*)/);
        if (!taskMatch) return;

        const prefix = taskMatch[1];
        const rawContent = taskMatch[2];
        const now = moment().format('YYYY-MM-DD');

        const basePrefix = prefix.replace(/\[.\]/, task.completed ? '[x]' : '[ ]');
        const cleanContent = rawContent.replace(this.completionRegex, '').trim();

        let finalLine = basePrefix + cleanContent;
        if (task.completed) {
            finalLine += ` [completed: ${now}]`;
        }
        await this.plugin.safeModifyLine(file, task.line, finalLine.trimEnd());
    }
}
