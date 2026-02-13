# Fast Todos - Feature Roadmap

## Design Philosophy
- **Performance First**: Never sacrifice speed for features
- **Vault-Wide**: Aggregate tasks from entire vault efficiently
- **Lightweight**: Minimal resource usage, even with 1000+ tasks
- **Native Feel**: Leverage Obsidian's strengths, not reinvent them

---

## 🔥 High Priority (High Impact, Low Overhead)

### 1. **Incremental Cache Updates** 
**Problem**: Full vault scans are expensive  
**Solution**: Listen to file modification events and only rescan changed files  
**Performance**: 10-100x faster for typical workflows  
**Implementation**:
```typescript
// Instead of scanning entire vault on every refresh
// Track which files changed and only rescan those
registerEvent(vault.on('modify', (file) => {
  if (isTaskFile(file)) {
    updateTasksFromFile(file);
  }
}));
```

### 2. **Saved Views / Quick Filters**
**Problem**: Users type the same filter queries repeatedly  
**Solution**: Save common filter combinations as named views  
**Example Views**:
- `Today` → `not done AND (due OR priority is high)`
- `This Week` → `not done AND due before 2026-02-21`
- `Project X` → `path includes projects/project-x`
- `Urgent` → `priority is high AND overdue`

**UI**: Tabs or dropdown above the task list
**Storage**: Save in plugin settings, very lightweight

### 3. **Quick Task Capture**
**Problem**: Breaking flow to open a file to add a task  
**Solution**: Command palette action to add task to designated "Inbox" note  
**Features**:
- Press hotkey → modal opens
- Type task → Enter → done
- Task appears in configurable inbox file (e.g., `Daily/Today.md` or `Inbox.md`)
- Optional: Auto-add to current daily note

**Performance**: Single file append, instant

### 4. **Smart Grouping Options**
**Current**: Group by file  
**Enhancement**: Group by:
- `Due Date` (Overdue, Today, This Week, Later, No Date)
- `Priority` (High → Normal → Low)
- `Status` (In Progress → Not Started → Done)
- `Folder` (Better than full path for organization)
- `Tag` (Extract from task text: `#project-alpha`)

**Performance**: All computed during render, no extra scanning

### 5. **Subtask Support (Visual Only)**
**Problem**: Flat task lists miss relationships  
**Solution**: Visually indent tasks that are indented in source  
**Current State**: You already track `indent` in tasks!  
**Enhancement**: 
- Show visual hierarchy
- Optional: Roll-up progress (2/5 subtasks done)
- Optional: Collapse/expand parent tasks

**Performance**: Zero cost, just visual formatting

---

## 🚀 Medium Priority (Good Value, Moderate Effort)

### 6. **Natural Language Due Dates**
**Current**: Manual `[due: 2026-02-14]` syntax  
**Enhancement**: Type "tomorrow", "next friday", "in 3 days"  
**Implementation**: Use moment.js (already included!)
```typescript
// In edit modal or quick capture
parseDueDate("tomorrow") → "2026-02-15"
parseDueDate("next wed") → "2026-02-19"
```

### 7. **Batch Operations**
**Problem**: Updating 20 tasks one-by-one is tedious  
**Solution**: Multi-select + bulk actions
- Select multiple tasks (checkbox or Shift+Click)
- Actions: Mark Done, Set Priority, Change Due Date, Delete, Move to File
**Performance**: Single vault write per action type

### 8. **Task Templates**
**Use Case**: Create recurring task patterns quickly  
**Example Templates**:
- "Weekly Review" → Creates 5 predefined tasks
- "New Project Setup" → Creates task breakdown
- "Blog Post" → Draft → Review → Publish → Promote

**Storage**: JSON in settings, expand on capture

### 9. **Today/Agenda View**
**Concept**: Dedicated view for time-sensitive tasks  
**Auto-filters**:
- Overdue tasks (red, top)
- Due today (yellow)
- Due this week (sorted by date)
- High priority without date

**Visual**: Timeline or calendar-style compact view  
**Performance**: Same cache, different filter

### 10. **Completion Statistics**
**Lightweight Analytics**:
- Tasks completed today/this week/this month
- Completion rate by priority
- Most productive days/times
- Streaks (tasks completed N days in a row)

**Storage**: Aggregate on-demand from cache  
**Display**: Small widget or command palette

---

## 💡 Lower Priority (Nice to Have)

### 11. **Task Dependencies**
**Syntax**: `[blocked-by: [[Daily/2026-02-10#task-id]]]`  
**Visual**: Gray out blocked tasks, show blocker link  
**Complexity**: Moderate - need task IDs and link resolution

### 12. **Recurring Tasks**
**Syntax**: `[recur: daily]` or `[recur: weekly on monday]`  
**Behavior**: Auto-create new task when marked done  
**Implementation**: Hook into completion event, clone task with new due date

### 13. **Time Estimates & Tracking**
**Syntax**: `[estimate: 2h]`, `[logged: 1.5h]`  
**Visual**: Progress bar on task  
**Use**: Planning capacity, tracking actuals

### 14. **Archive Completed Tasks**
**Problem**: Completed tasks clutter the list  
**Solution**: Command to move done tasks to archive file  
**Options**:
- Archive daily/weekly/monthly
- Keep in source file but hide in view
- Move to `Archive/YYYY-MM.md`

### 15. **Mobile Quick Toggles**
**Current**: Full edit modal  
**Enhancement**: Long-press for quick menu:
- Toggle priority (cycle High → Normal → Low)
- Defer (due +1 day, +1 week)
- Move to different file

---

## 🎯 Performance Optimizations

### A. **Lazy Loading**
Only render visible tasks (virtual scrolling)  
**Benefit**: Instant load even with 5000+ tasks

### B. **Web Worker for Parsing**
Move markdown parsing off main thread  
**Benefit**: UI stays responsive during vault scan

### C. **IndexedDB Cache**
Persist task cache across Obsidian restarts  
**Benefit**: Zero startup cost, instant first render

### D. **Debounced Auto-Refresh**
Don't refresh on every keystroke during editing  
**Benefit**: Smoother typing experience

---

## 📊 Implementation Complexity vs Impact

```
High Impact, Low Effort:     High Impact, High Effort:
- Incremental cache          - Web worker parsing
- Saved filter views         - Recurring tasks
- Quick capture              - Dependencies

Low Impact, Low Effort:      Low Impact, High Effort:
- Subtask visuals            - Full calendar view
- Natural language dates     - AI task suggestions
```

---

## 🏁 Suggested Next Steps

### Phase 1 (This Month)
1. **Incremental cache updates** - Biggest performance win
2. **Saved views** - Biggest usability improvement  
3. **Quick capture** - Most requested power-user feature

### Phase 2 (Next Month)
4. **Smart grouping** - Leverage existing data better
5. **Batch operations** - Efficiency at scale
6. **Completion stats** - User engagement/motivation

### Phase 3 (Future)
7. Consider recurring tasks, time tracking, or dependencies based on user feedback

---

## 💭 Ideas to Avoid (Performance Killers)

❌ **Full-text search across all notes** - Use Obsidian's native search  
❌ **Real-time sync to external services** - Defeats "fast" purpose  
❌ **Heavy animations** - Keep it snappy  
❌ **Image attachments on tasks** - Scope creep  
❌ **Built-in time tracker with history** - Use dedicated plugins  
❌ **AI/ML features** - Out of scope for "fast"

---

## 🔧 Technical Notes

### Current Performance Profile
- Cache TTL: 2 minutes (good)
- Full vault scan: ~200ms per 1000 tasks (decent)
- Render: ~50ms for 100 visible tasks (excellent)

### Bottlenecks to Watch
1. **File I/O**: Reading 500+ markdown files
2. **Regex matching**: Parsing task syntax
3. **DOM manipulation**: Rendering long lists

### Best Practices
- Always measure before optimizing
- Profile with real vaults (1000+ notes)
- Test on mobile devices
- Keep bundle size under 100KB
