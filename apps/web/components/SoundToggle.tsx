'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff } from 'lucide-react';
import { getSoundSettings, onSoundSettingsChange, setSoundSettings, unlockAudio } from '../lib/sounds';

/** Быстрое «без звука» — в шапке списка чатов. Подробные настройки — в /settings. */
export function SoundToggle() {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    setEnabled(getSoundSettings().enabled);
    return onSoundSettingsChange((s) => setEnabled(s.enabled));
  }, []);
  return (
    <button
      type="button"
      onClick={() => {
        unlockAudio();
        setSoundSettings({ enabled: !enabled });
      }}
      title={enabled ? 'Звуки включены — нажмите, чтобы выключить' : 'Звуки выключены — нажмите, чтобы включить'}
      aria-pressed={!enabled}
      className={`btn-icon h-7 w-7 ${enabled ? '' : 'text-danger'}`}
    >
      {enabled ? <Bell size={14} /> : <BellOff size={14} />}
    </button>
  );
}
