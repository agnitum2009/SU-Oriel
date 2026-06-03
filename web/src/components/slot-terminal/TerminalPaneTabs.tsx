import { SLOT_TERMINAL_ROLES, type SlotTerminalPaneRole, type SlotTerminalPaneTarget } from "../../types/slot-terminal.js";
import styles from "./SlotTerminalPanel.module.css";

export interface TerminalPaneTabsProps {
  activeRole: SlotTerminalPaneRole;
  panesByRole: ReadonlyMap<SlotTerminalPaneRole, SlotTerminalPaneTarget>;
  onSelectRole: (role: SlotTerminalPaneRole) => void;
}

export function TerminalPaneTabs(props: TerminalPaneTabsProps) {
  return (
    <div aria-label="Slot terminal panes" className={styles.tabs} role="tablist">
      {SLOT_TERMINAL_ROLES.map((role) => {
        const available = props.panesByRole.has(role);
        return (
          <button
            aria-selected={props.activeRole === role}
            className={styles.tab}
            data-active={props.activeRole === role}
            disabled={!available}
            key={role}
            onClick={() => props.onSelectRole(role)}
            role="tab"
            type="button"
          >
            {role}
          </button>
        );
      })}
    </div>
  );
}
