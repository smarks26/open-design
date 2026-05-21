import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { OpenDesignHostUpdaterStatusSnapshot } from '@open-design/host';

import { Icon } from './Icon';
import {
  checkForUpdaterUpdate,
  deriveUpdaterModel,
  downloadUpdaterUpdate,
  openUpdaterInstaller,
  quitAfterUpdaterInstallerOpen,
  readUpdaterStatus,
  subscribeToUpdaterStatus,
  type UpdaterModel,
} from '../lib/updater';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';

type InstallState = 'idle' | 'opening' | 'opened' | 'quitting';
type Translator = (key: keyof Dict, vars?: Record<string, string | number>) => string;

function versionText(t: Translator, model: UpdaterModel): string {
  const version = model.availableVersion;
  return version == null ? t('updater.readyGeneric') : t('updater.readyVersion', { version });
}

function navLabel(t: Translator, model: UpdaterModel): string {
  if (model.errorMessage != null) return t('updater.failed');
  if (model.installerOpened) return t('updater.installerOpened');
  if (model.status?.state === 'checking') return t('updater.checking');
  if (model.downloadProgress != null || model.busy) {
    const percent = model.downloadProgress?.percent;
    return percent == null ? t('updater.downloading') : t('updater.downloadingPercent', { percent });
  }
  if (model.hasDownloadedInstaller) return t('updater.ready');
  if (model.upToDate || model.status?.state === 'idle') return t('updater.upToDate');
  return t('updater.available');
}

function channelLabelFor(channel: string | null | undefined): string | null {
  switch (channel) {
    case 'beta':
      return 'Beta channel';
    case 'nightly':
      return 'Nightly channel';
    case 'preview':
      return 'Preview channel';
    case 'stable':
      return 'Stable channel';
    default:
      return null;
  }
}

export function UpdaterPopup() {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const actionInFlightRef = useRef(false);
  const [model, setModel] = useState<UpdaterModel>(() => deriveUpdaterModel(null));
  const [dismissedPromptKey, setDismissedPromptKey] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [installState, setInstallState] = useState<InstallState>('idle');
  const [actionError, setActionError] = useState<string | null>(null);
  const [manualChecking, setManualChecking] = useState(false);

  useEffect(() => {
    let mounted = true;
    const applyStatus = (status: OpenDesignHostUpdaterStatusSnapshot) => {
      if (!mounted) return;
      setModel(deriveUpdaterModel(status, { hostAvailable: true }));
    };
    const unsubscribe = subscribeToUpdaterStatus(applyStatus);
    void readUpdaterStatus({ payload: { source: 'updater-popup:mount' } }).then((result) => {
      if (!mounted) return;
      if (result.ok) {
        setModel(result.model);
      } else {
        setModel(deriveUpdaterModel(null, { hostAvailable: false }));
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const isPanelOpen = useMemo(() => {
    if (actionError != null) return true;
    if (panelOpen) return true;
    if (!model.shouldPrompt || model.promptKey == null) return false;
    return model.promptKey !== dismissedPromptKey;
  }, [actionError, dismissedPromptKey, model.promptKey, model.shouldPrompt, panelOpen]);

  const close = useCallback(() => {
    if (installState === 'opening' || installState === 'quitting') return;
    if (model.promptKey != null) setDismissedPromptKey(model.promptKey);
    setPanelOpen(false);
    setInstallState('idle');
    setActionError(null);
  }, [installState, model.promptKey]);

  useEffect(() => {
    if (!isPanelOpen) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!wrapRef.current?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [close, isPanelOpen]);

  if (model.environment !== 'desktop' || (!model.shouldShowControl && actionError == null)) return null;

  const checkNow = async () => {
    if (!model.canCheck || manualChecking) return;
    setPanelOpen(true);
    setManualChecking(true);
    setActionError(null);
    try {
      const result = await checkForUpdaterUpdate({ payload: { source: 'updater-popup:manual' } });
      if (result.ok) {
        setModel(result.model);
      } else {
        setActionError(result.reason);
      }
    } finally {
      setManualChecking(false);
    }
  };

  const downloadNow = async () => {
    if (!model.canDownload || manualChecking) return;
    setManualChecking(true);
    setActionError(null);
    try {
      const result = await downloadUpdaterUpdate({ payload: { source: 'updater-popup:manual-download' } });
      if (result.ok) {
        setModel(result.model);
      } else {
        setActionError(result.reason);
      }
    } finally {
      setManualChecking(false);
    }
  };

  const requestQuitOpenDesign = async () => {
    setInstallState('quitting');
    setActionError(null);
    const result = await quitAfterUpdaterInstallerOpen({ payload: { source: 'updater-popup' } });
    if (!result.ok) {
      actionInFlightRef.current = false;
      setActionError(result.reason);
      setInstallState('opened');
    }
  };

  const quitOpenDesign = async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    await requestQuitOpenDesign();
  };

  const installAndQuit = async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    try {
      setInstallState('opening');
      setActionError(null);
      const result = await openUpdaterInstaller({ payload: { source: 'updater-popup' } });
      if (!result.ok) {
        actionInFlightRef.current = false;
        setActionError(result.reason);
        setInstallState('idle');
        return;
      }
      setModel(result.model);
      if (result.model.errorMessage != null) {
        actionInFlightRef.current = false;
        setActionError(result.model.errorMessage);
        setInstallState('idle');
        return;
      }
      setPanelOpen(true);
      await requestQuitOpenDesign();
    } catch (error) {
      actionInFlightRef.current = false;
      setActionError(error instanceof Error ? error.message : String(error));
      setInstallState('idle');
    }
  };

  const openingInstaller = installState === 'opening';
  const quitting = installState === 'quitting';
  const actionInFlight = openingInstaller || quitting || manualChecking;
  const opened = installState === 'opened' || quitting || model.installerOpened;
  const statusError = model.errorMessage;
  const failed = actionError != null || statusError != null;
  const checking = model.status?.state === 'checking' || (manualChecking && !model.hasDownloadedInstaller);
  const updateAvailable = model.status?.state === 'available';
  const current = model.upToDate || model.status?.state === 'idle';
  const title = failed
    ? opened
      ? t('updater.quitFailedTitle')
      : t('updater.failed')
    : opened
      ? t('updater.installerOpened')
      : checking
        ? t('updater.checking')
        : current
          ? t('updater.upToDate')
          : model.hasDownloadedInstaller
            ? t('updater.ready')
            : t('updater.available');
  const body = failed
    ? opened
      ? t('updater.quitFailedBody')
      : statusError ?? t('updater.openFailedFallback')
    : opened
      ? t('updater.installerOpenBody')
      : checking
        ? t('updater.checking')
        : current
          ? t('updater.upToDate')
          : model.hasDownloadedInstaller
            ? versionText(t, model)
            : t('updater.availableBody', { version: model.availableVersion ?? t('updater.ready') });
  const progress = model.downloadProgress;
  const progressStyle = {
    '--updater-progress': `${progress?.percent ?? 0}%`,
  } as CSSProperties;
  const controlDisabled = actionInFlight || (model.busy && !model.hasDownloadedInstaller && !model.installerOpened);
  const controlLabel = navLabel(t, model);
  const canOpenInstaller = model.canOpenInstaller && model.hasDownloadedInstaller;
  const updaterTone = failed
    ? ' is-error'
    : opened
    ? ' is-opened'
    : progress != null
    ? ' is-progress'
    : model.hasDownloadedInstaller
    ? ' is-ready'
    : current
    ? ' is-current'
    : ' is-available';
  const channelLabel = channelLabelFor(model.status?.channel);

  return (
    <div className="entry-updater-menu" ref={wrapRef}>
      <button
        aria-disabled={controlDisabled ? 'true' : undefined}
        aria-expanded={isPanelOpen}
        aria-label={controlLabel}
        className={`entry-nav-rail__btn entry-updater-menu__button${updaterTone}${isPanelOpen ? ' is-active' : ''}${controlDisabled ? ' is-disabled' : ''}`}
        data-testid="entry-nav-updater"
        data-tooltip={controlLabel}
        title={controlLabel}
        type="button"
        onClick={() => {
          if (controlDisabled) return;
          if (isPanelOpen) {
            close();
            return;
          }
          if (!failed && !opened && !updateAvailable && !model.hasDownloadedInstaller && progress == null) {
            void checkNow();
            return;
          }
          setPanelOpen(true);
        }}
      >
        <span className="entry-updater-menu__glyph">
          <Icon
            name={model.hasDownloadedInstaller || progress != null || updateAvailable ? 'arrow-up' : 'check'}
            size={18}
            strokeWidth={2.25}
          />
        </span>
        {progress != null ? (
          <span
            aria-label={controlLabel}
            aria-valuemax={100}
            aria-valuemin={0}
            {...(progress.percent == null ? {} : { 'aria-valuenow': progress.percent })}
            className="entry-updater-menu__progress"
            data-testid="entry-nav-updater-progress"
            role="progressbar"
            style={progressStyle}
          />
        ) : null}
      </button>
      {isPanelOpen ? (
        <section
          aria-labelledby="updater-popup-title"
          className={`updater-popup${updaterTone}`}
          data-testid="updater-popup"
          role="dialog"
        >
          <div className="updater-popup__icon">
            <Icon name={opened || current ? 'check' : 'arrow-up'} size={20} strokeWidth={2.2} />
          </div>
          <div className="updater-popup__body">
            <h2 id="updater-popup-title">{title}</h2>
            <p>{body}</p>
            {channelLabel != null && !failed ? <span className="updater-popup__badge">{channelLabel}</span> : null}
            {actionError != null && actionError !== body ? <p className="updater-popup__error">{actionError}</p> : null}
          </div>
          <div className="updater-popup__actions">
            {opened ? (
              quitting ? (
                <button className="updater-popup__button updater-popup__button--primary" disabled type="button">
                  {t('updater.quitting')}
                </button>
              ) : (
                <>
                  <button className="updater-popup__button" type="button" onClick={close}>
                    {t('updater.done')}
                  </button>
                  <button
                    className="updater-popup__button updater-popup__button--primary"
                    data-testid="updater-quit-button"
                    disabled={!model.canQuitAfterInstallerOpen || quitting}
                    type="button"
                    onClick={() => {
                      void quitOpenDesign();
                    }}
                  >
                    {t('updater.quitButton')}
                  </button>
                </>
              )
            ) : failed || current ? (
              <button className="updater-popup__button" type="button" onClick={close}>
                {t('updater.done')}
              </button>
            ) : checking ? (
              <button className="updater-popup__button updater-popup__button--primary" disabled type="button">
                {t('updater.checking')}
              </button>
            ) : updateAvailable && !model.hasDownloadedInstaller ? (
              <>
                <button className="updater-popup__button" disabled={actionInFlight} type="button" onClick={close}>
                  {t('updater.later')}
                </button>
                <button
                  className="updater-popup__button updater-popup__button--primary"
                  disabled={actionInFlight}
                  type="button"
                  onClick={() => {
                    void downloadNow();
                  }}
                >
                  {t('updater.download')}
                </button>
              </>
            ) : (
              <>
                <button className="updater-popup__button" disabled={actionInFlight} type="button" onClick={close}>
                  {t('updater.later')}
                </button>
                <button
                  className="updater-popup__button updater-popup__button--primary"
                  data-testid="updater-install-button"
                  disabled={openingInstaller || !canOpenInstaller}
                  type="button"
                  onClick={() => {
                    void installAndQuit();
                  }}
                >
                  {openingInstaller ? t('updater.opening') : t('updater.openInstaller')}
                </button>
              </>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
