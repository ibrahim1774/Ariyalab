import { useId, useState } from 'react';
import styles from './Accordion.module.css';

/** FAQ-style accordion. Only one item is open at a time; clicking the open item closes it. */
export default function Accordion({ items, defaultOpenId = null }) {
  const [openId, setOpenId] = useState(defaultOpenId);
  const base = useId();

  return (
    <div className={styles.list}>
      {items.map((item) => {
        const open = openId === item.id;
        const panelId = `${base}-${item.id}-panel`;
        return (
          <div key={item.id} className={`${styles.item} ${open ? styles.open : ''}`}>
            <button
              type="button"
              className={styles.trigger}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpenId(open ? null : item.id)}
            >
              <span>{item.title}</span>
              <span className={styles.icon} aria-hidden="true" />
            </button>
            <div id={panelId} role="region" hidden={!open} className={styles.panel}>
              {item.body}
            </div>
          </div>
        );
      })}
    </div>
  );
}
