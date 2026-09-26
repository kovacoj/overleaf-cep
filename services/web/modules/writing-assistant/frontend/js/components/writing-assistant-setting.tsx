/**
 * Settings section for the LanguageTool-based grammar/style assistant,
 * shown in the spell-check tab of the editor settings modal.
 *
 * Mode: off / grammar only / grammar + style
 * Language: automatic (follows the spell-check language) or a fixed one
 *
 * Preferences are stored in localStorage ("ol-writing-assistance") and the
 * editor extension picks them up via the "editor:writing-assistance-settings"
 * window event. The ignore list can be cleared here.
 */
import { useMemo } from 'react'
import getMeta from '@/utils/meta'
import {
  SETTINGS_EVENT,
  settings,
  IGNORED_KEY,
} from '../extensions/grammar-assistant'

const update = (patch: Record<string, unknown>) => {
  const current = settings()
  window.localStorage.setItem(
    'ol-writing-assistance',
    JSON.stringify({ ...current, ...patch })
  )
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function writingAssistantSection(): any {
  const { mode, language } = settings()

  const languages = useMemo(
    () =>
      (getMeta('ol-languages') ?? []).map(
        (language: { code: string; name: string }) => ({
          value: language.code,
          label: language.name,
        })
      ),
    []
  )

  return {
    key: 'writing-assistant',
    title: 'Grammar and style (LanguageTool)',
    settings: [
      {
        key: 'writing-assistance-mode',
        component: (
          <div className="form-controls" key="writing-assistance-mode">
            <label className="control-label" htmlFor="writing-assistance-mode">
              Grammar and style checking
            </label>
            <select
              id="writing-assistance-mode"
              className="form-control"
              value={mode ?? 'grammar'}
              onChange={e => update({ mode: e.target.value })}
            >
              <option value="off">Off</option>
              <option value="grammar">Grammar only</option>
              <option value="style">Grammar and style</option>
            </select>
            <p className="small">
              Runs automatically on your prose via a self-hosted LanguageTool
              service. Spelling remains handled by the built-in spell
              checker; math, commands, citations and labels are not checked.
            </p>
          </div>
        ),
      },
      {
        key: 'writing-assistance-language',
        component: (
          <div className="form-controls" key="writing-assistance-language">
            <label
              className="control-label"
              htmlFor="writing-assistance-language"
            >
              Checking language
            </label>
            <select
              id="writing-assistance-language"
              className="form-control"
              value={language ?? ''}
              onChange={e => update({ language: e.target.value })}
            >
              <option value="">Automatic (use spell-check language)</option>
              {languages.map(l => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        ),
      },
      {
        key: 'writing-assistance-clear-ignored',
        component: (
          <div className="form-controls" key="writing-assistance-clear-ignored">
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                window.localStorage.removeItem(IGNORED_KEY)
                window.dispatchEvent(new CustomEvent(SETTINGS_EVENT))
              }}
            >
              Clear ignored suggestions
            </button>
          </div>
        ),
      },
    ],
  }
}
