'use client';

import { useEffect, useRef, useState } from 'react';
import { Volume2, VolumeX, Play, Square, MessageSquare, PhoneIncoming, Info, Send } from 'lucide-react';
import {
  getSoundSettings,
  setSoundSettings,
  onSoundSettingsChange,
  playSound,
  startRingtone,
  startRingback,
  unlockAudio,
  DEFAULT_SOUND_SETTINGS,
  type SoundSettings,
  type SoundName,
} from '../lib/sounds';

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-ink/15'
      }`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow-xs transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
    </button>
  );
}

type PreviewKey = 'message' | 'sent' | 'ring' | 'ringback' | 'call-connected' | 'call-ended';

/** Настройки звуков (хранятся на этом устройстве) с прослушиванием каждого. */
export function SoundSettingsCard() {
  const [s, setS] = useState<SoundSettings>(DEFAULT_SOUND_SETTINGS);
  const [playing, setPlaying] = useState<PreviewKey | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setS(getSoundSettings());
    return onSoundSettingsChange(setS);
  }, []);
  useEffect(() => () => stopRef.current?.(), []);

  const update = (patch: Partial<SoundSettings>) => setS(setSoundSettings(patch));

  const preview = (key: PreviewKey) => {
    unlockAudio();
    stopRef.current?.();
    stopRef.current = null;
    if (playing === key) {
      setPlaying(null);
      return;
    }
    if (key === 'ring' || key === 'ringback') {
      const stop = key === 'ring' ? startRingtone({ force: true, maxMs: 8000 }) : startRingback({ force: true, maxMs: 8000 });
      const timer = setTimeout(() => setPlaying(null), 8000);
      stopRef.current = () => {
        stop();
        clearTimeout(timer);
      };
      setPlaying(key);
    } else {
      playSound(key as SoundName, { force: true });
      setPlaying(key);
      setTimeout(() => setPlaying((p) => (p === key ? null : p)), 900);
    }
  };

  const rows: { key: keyof Pick<SoundSettings, 'messages' | 'calls' | 'sent'>; icon: typeof MessageSquare; title: string; desc: string; previews: { key: PreviewKey; label: string }[] }[] = [
    {
      key: 'messages',
      icon: MessageSquare,
      title: 'Новые сообщения',
      desc: 'Когда чат не открыт на экране — на любой странице приложения.',
      previews: [{ key: 'message', label: 'Сообщение' }],
    },
    {
      key: 'calls',
      icon: PhoneIncoming,
      title: 'Звонки',
      desc: 'Входящий звонок, гудки при вызове, подключение и завершение.',
      previews: [
        { key: 'ring', label: 'Входящий' },
        { key: 'ringback', label: 'Гудки' },
        { key: 'call-connected', label: 'Соединение' },
        { key: 'call-ended', label: 'Завершение' },
      ],
    },
    {
      key: 'sent',
      icon: Send,
      title: 'Отправка сообщения',
      desc: 'Короткий тихий щелчок, когда ваше сообщение ушло.',
      previews: [{ key: 'sent', label: 'Отправка' }],
    },
  ];

  return (
    <section className="card">
      <div className="card-header">
        <div>
          <h2 className="card-title">Звуки</h2>
          <p className="card-desc">Сохраняются на этом устройстве — на ноутбуке и телефоне можно настроить по-разному.</p>
        </div>
        <Switch checked={s.enabled} onChange={(v) => update({ enabled: v })} label="Звуки включены" />
      </div>

      <div className={`divide-y divide-line/[0.06] ${s.enabled ? '' : 'opacity-50'}`}>
        <div className="flex items-center gap-3 px-5 py-4">
          <button type="button" onClick={() => update({ volume: s.volume > 0 ? 0 : 0.6 })} className="btn-icon-sm" title={s.volume > 0 ? 'Без звука' : 'Включить'}>
            {s.volume > 0 ? <Volume2 size={15} /> : <VolumeX size={15} />}
          </button>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(s.volume * 100)}
            disabled={!s.enabled}
            onChange={(e) => update({ volume: Number(e.target.value) / 100 })}
            onPointerUp={() => {
              unlockAudio();
              playSound('message', { force: true });
            }}
            className="h-1 flex-1 cursor-pointer accent-[rgb(var(--accent))]"
            aria-label="Громкость"
          />
          <span className="w-10 text-right text-xs tabular-nums text-ink-muted">{Math.round(s.volume * 100)}%</span>
        </div>

        {rows.map(({ key, icon: Icon, title, desc, previews }) => (
          <div key={key} className="flex items-start gap-3 px-5 py-4">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-ink-muted">
              <Icon size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{title}</p>
              <p className="mt-0.5 text-xs text-ink-muted">{desc}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {previews.map((p) => (
                  <button key={p.key} type="button" onClick={() => preview(p.key)} className="btn-secondary btn-sm h-7 gap-1 px-2 text-xs">
                    {playing === p.key ? <Square size={11} className="fill-current" /> : <Play size={11} className="fill-current" />}
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <Switch checked={s[key]} onChange={(v) => update({ [key]: v })} disabled={!s.enabled} label={title} />
          </div>
        ))}
      </div>
      <p className="flex items-start gap-1.5 border-t border-line/[0.06] px-5 py-3 text-xs text-ink-faint">
        <Info size={12} className="mt-0.5 shrink-0" />
        Браузер разрешает звук только после первого клика на странице: если вкладку открыли и ещё ничего не нажимали, входящий звонок
        будет виден по баннеру и мигающему заголовку вкладки.
      </p>
    </section>
  );
}
