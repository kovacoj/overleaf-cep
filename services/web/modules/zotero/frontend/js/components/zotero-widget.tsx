import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import { getJSON, deleteJSON, postJSON } from '@/infrastructure/fetch-json'
import useAsync from '@/shared/hooks/use-async'
import { debugConsole } from '@/utils/debugging'
import OLButton from '@/shared/components/ol/ol-button'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import OLNotification from '@/shared/components/ol/ol-notification'
import ZoteroLogo from '@/shared/svgs/zotero-logo'
import OLFormControl from '@/shared/components/ol/ol-form-control'

/**
 * Zotero account linking widget for the Account Settings page.
 * Instead of OAuth, users paste their Zotero API key directly.
 * Create one at https://www.zotero.org/settings/keys with:
 *   - "Allow library access"
 *   - "Allow read access to all groups" (for group library imports)
 *
 * Registered via overleafModuleImports.referenceLinkingWidgets.
 */
export const ZoteroWidget = function ZoteroWidget() {
  const { t } = useTranslation()
  const { appName } = getMeta('ol-ExposedSettings')

  const {
    isLoading: isCheckingConn,
    isError: isErrorConnCheck,
    runAsync: runAsyncConnCheck,
    data: isConnected,
    setData: setConnState,
  } = useAsync<boolean>()

  const {
    isLoading: isUnlinking,
    isError: isErrorUnlink,
    runAsync: runAsyncUnlink,
  } = useAsync<void>()

  const [showUnlinkModal, setShowUnlinkModal] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [linkError, setLinkError] = useState('')
  const [isLinking, setIsLinking] = useState(false)

  const handleConnCheck = useCallback(() => {
    runAsyncConnCheck(getJSON('/user/zotero/status')).catch((err) =>
      debugConsole.error(err?.data?.message || err?.message || err),
    )
  }, [runAsyncConnCheck])

  useEffect(() => {
    handleConnCheck()
  }, [handleConnCheck])

  const handleUnlink = useCallback(() => {
    runAsyncUnlink(deleteJSON('/user/zotero'))
      .then(() => setConnState(false))
      .catch((err) =>
        debugConsole.error(err?.data?.message || err?.message || err),
      )
      .finally(() => setShowUnlinkModal(false))
  }, [runAsyncUnlink])

  const handleLink = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      setIsLinking(true)
      setLinkError('')
      try {
        await postJSON('/user/zotero', { body: { apiKey } })
        setApiKey('')
        setConnState(true)
      } catch (err: any) {
        setLinkError(err?.data?.message || t('generic_something_went_wrong'))
      } finally {
        setIsLinking(false)
      }
    },
    [apiKey, setConnState, t],
  )

  if (isCheckingConn) {
    return (
      <div className="settings-widget-container">
        <div>
          <ZoteroLogo />
        </div>

        <div className="description-container">
          <div className="title-row">
            <h4>GitHub</h4>
          </div>

          <p className="small">
            <span>{t('loading')}…</span>
          </p>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="settings-widget-container">
        <div>
          <ZoteroLogo size={40} />
        </div>

        <div className="description-container">
          <div className="title-row">
            <h4 id="zotero-link">{t('zotero')}</h4>
          </div>

          <p className="small">{t('zotero_sync_description', { appName })}</p>

          {isErrorConnCheck && (
            <OLNotification
              type="error"
              content={t('problem_checking_connection_with_provider', {
                provider: t('zotero'),
              })}
            />
          )}

          {isErrorUnlink && (
            <OLNotification
              type="error"
              content={t('generic_something_went_wrong')}
            />
          )}
          {linkError && <OLNotification type="error" content={linkError} />}
          {!isConnected && !isErrorConnCheck && (
            <form onSubmit={handleLink}>
              <p className="small text-muted">
                Create a key at{' '}
                <a
                  href="https://www.zotero.org/settings/keys/new"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  zotero.org/settings/keys
                </a>{' '}
                with library access enabled.
              </p>
              <OLFormControl
                type="password"
                placeholder="Zotero API key"
                value={apiKey}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                  setApiKey(event.target.value.trim())
                }
                autoComplete="off"
                disabled={isLinking}
              />
              <OLButton
                variant="primary"
                type="submit"
                disabled={!apiKey || isLinking}
              >
                {isLinking ? t('linking') : t('link')}
              </OLButton>
            </form>
          )}
        </div>

        <div>
          {isConnected ? (
            <OLButton
              variant="danger-ghost"
              onClick={() => setShowUnlinkModal(true)}
              disabled={isUnlinking}
            >
              {isUnlinking ? t('unlinking') : t('unlink')}
            </OLButton>
          ) : isErrorConnCheck ? (
            <OLButton variant="secondary" onClick={handleConnCheck}>
              {t('reconnect')}
            </OLButton>
          ) : null}
        </div>
      </div>

      <OLModal
        id="zotero-unlink-modal"
        show={showUnlinkModal}
        onHide={() => setShowUnlinkModal(false)}
        backdrop="static"
      >
        <OLModalHeader>
          <OLModalTitle>
            {t('unlink_reference', {
              provider: 'Zotero',
            })}
          </OLModalTitle>
        </OLModalHeader>

        <OLModalBody>
          <p>
            {t('unlink_warning_reference', {
              provider: 'Zotero',
            })}
          </p>
        </OLModalBody>

        <OLModalFooter>
          <OLButton
            variant="secondary"
            onClick={() => setShowUnlinkModal(false)}
          >
            {t('cancel')}
          </OLButton>

          <OLButton
            variant="danger-ghost"
            onClick={handleUnlink}
            disabled={isUnlinking}
          >
            {isUnlinking ? t('unlinking') : t('unlink')}
          </OLButton>
        </OLModalFooter>
      </OLModal>
    </>
  )
}
