import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectRecord, SessionRecord } from "../shared/contracts";
import {
  workspaceSearchItems,
  type WorkspaceSearchItem,
} from "./workspace-search";

interface QuickSwitcherProps {
  projects: ProjectRecord[];
  sessions: SessionRecord[];
  onClose(): void;
  onSelect(item: WorkspaceSearchItem): void;
}

export function QuickSwitcher({
  projects,
  sessions,
  onClose,
  onSelect,
}: QuickSwitcherProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const items = useMemo(
    () => workspaceSearchItems(projects, sessions, query).slice(0, 14),
    [projects, query, sessions],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const choose = (item: WorkspaceSearchItem) => {
    onSelect(item);
    onClose();
  };

  return (
    <div
      className="quick-switcher-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section
        className="quick-switcher"
        role="dialog"
        aria-modal="true"
        aria-label="快速切换工程或会话"
      >
        <div className="quick-switcher-input-row">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索工程、目录或会话…"
            aria-label="搜索工程或会话"
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((index) =>
                  items.length ? (index + 1) % items.length : 0,
                );
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((index) =>
                  items.length ? (index - 1 + items.length) % items.length : 0,
                );
                return;
              }
              if (event.key === "Enter" && items[selectedIndex]) {
                event.preventDefault();
                choose(items[selectedIndex]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="quick-switcher-results" role="listbox">
          {items.length ? (
            items.map((item, index) => (
              <button
                className={`quick-switcher-item ${index === selectedIndex ? "quick-switcher-item--selected" : ""}`}
                key={item.key}
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => choose(item)}
              >
                <span
                  className={`quick-switcher-kind quick-switcher-kind--${item.kind}`}
                  aria-hidden="true"
                >
                  {item.kind === "project" ? "▱" : "›_"}
                </span>
                <span className="quick-switcher-copy">
                  <strong>{item.title}</strong>
                  <small>{item.subtitle}</small>
                </span>
                <span className="quick-switcher-type">
                  {item.kind === "project" ? "工程" : "会话"}
                </span>
              </button>
            ))
          ) : (
            <div className="quick-switcher-empty">没有匹配的工程或会话</div>
          )}
        </div>

        <footer className="quick-switcher-footer">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Ctrl+K 呼出</span>
        </footer>
      </section>
    </div>
  );
}
