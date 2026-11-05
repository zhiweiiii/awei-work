import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  connect,
  disconnect,
  readCredential,
  saveLogin,
  type ConnectResult,
} from "@/modules/ssh/api";
import { updateSsh, type SshProfile } from "@/modules/ssh/store";

export function AuthDialog({
  profile,
  onCancel,
  onConnected,
  autoConnect = false,
}: {
  profile: SshProfile;
  onCancel: () => void;
  onConnected: (id: number) => void;
  autoConnect?: boolean;
}) {
  const [secret, setSecret] = useState("");
  const [remember, setRemember] = useState(profile.remember);
  const [loaded, setLoaded] = useState(!profile.remember);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [challenge, setChallenge] = useState<
    Extract<ConnectResult, { status: "hostKey" }>["key"] | null
  >(null);
  const live = useRef(true);
  const gate = useRef(false);
  const attempted = useRef(false);
  useEffect(() => {
    live.current = true;
    if (profile.remember)
      void readCredential(profile.id)
        .then((value) => {
          if (live.current) {
            setSecret(value ?? "");
            setLoaded(true);
          }
        })
        .catch((error: unknown) => {
          if (live.current) {
            setError(String(error));
            setLoaded(true);
          }
        });
    return () => {
      live.current = false;
    };
  }, [profile.id, profile.remember]);
  const submit = (fingerprint?: string) => {
    if (gate.current || !loaded) return;
    gate.current = true;
    setBusy(true);
    setError("");
    void (async () => {
      const result = await connect(profile, secret, fingerprint);
      if (!live.current) {
        if (result.status === "connected") await disconnect(result.id);
        return;
      }
      if (result.status === "hostKey") {
        setChallenge(result.key);
        return;
      }
      try {
        await saveLogin(profile.id, remember ? secret : null, () =>
          updateSsh((config) => ({
            ...config,
            profiles: config.profiles.map((item) =>
              item.id === profile.id ? { ...item, remember } : item,
            ),
          })),
        );
      } catch (error) {
        await disconnect(result.id);
        throw error;
      }
      if (!live.current) {
        await disconnect(result.id);
        return;
      }
      setSecret("");
      onConnected(result.id);
    })()
      .catch((error: unknown) => {
        if (live.current) setError(String(error));
      })
      .finally(() => {
        gate.current = false;
        if (live.current) setBusy(false);
      });
  };
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const canAutoConnect =
    autoConnect && (profile.auth === "key" || (profile.remember && !!secret));
  useEffect(() => {
    if (
      loaded &&
      canAutoConnect &&
      !attempted.current &&
      !error &&
      !challenge
    ) {
      attempted.current = true;
      submitRef.current();
    }
  }, [loaded, canAutoConnect, error, challenge]);
  const silent =
    autoConnect &&
    !error &&
    !challenge &&
    (!loaded || busy || (canAutoConnect && !attempted.current));
  return (
    <Dialog
      open={!silent}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent
        className="gap-4"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle>连接 {profile.name}</DialogTitle>
        <DialogDescription>
          {profile.username}@{profile.host}:{profile.port}
        </DialogDescription>
        <form
          className="grid gap-3 text-xs"
          onSubmit={(event) => {
            event.preventDefault();
            submit(challenge?.fingerprint);
          }}
        >
          {challenge ? (
            <div className="grid gap-2 rounded-lg border border-border p-3">
              <p className={challenge.previous ? "text-destructive" : ""}>
                {challenge.previous
                  ? "服务器指纹已改变，请核实后再连接。"
                  : "首次连接，请核对服务器指纹。"}
              </p>
              <code className="break-all select-text">
                {challenge.fingerprint}
              </code>
              {challenge.previous && (
                <p className="break-all text-muted-foreground">
                  之前：{challenge.previous}
                </p>
              )}
            </div>
          ) : (
            <>
              <label className="ssh-field">
                {profile.auth === "key" ? "密钥口令（可留空）" : "密码"}
                <input
                  type="password"
                  autoComplete="off"
                  disabled={!loaded || busy}
                  maxLength={2000}
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={remember}
                  disabled={busy}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                记住{profile.auth === "key" ? "密钥口令" : "密码"}
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="break-words text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="ssh-button" onClick={onCancel}>
              取消
            </button>
            <button
              type="submit"
              className="ssh-button bg-primary text-primary-foreground"
              disabled={busy || !loaded}
            >
              {busy ? "连接中…" : challenge ? "信任此指纹并连接" : "连接"}
            </button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
