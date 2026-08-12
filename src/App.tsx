import {
  ArchiveIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CopyIcon,
  DownloadIcon,
  FileTextIcon,
  InboxIcon,
  KeyRoundIcon,
  LayoutListIcon,
  LoaderCircleIcon,
  MailIcon,
  MoonIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SunIcon,
  TablePropertiesIcon,
  Trash2Icon,
  UploadIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { type AdSlotConfig } from "./ad";
import { save, ask } from "@tauri-apps/plugin-dialog";
import {
  type AccountFetchResult,
  type BatchRow,
  type BatchStatusFilter,
  type MailAccount,
  type MailFolder,
  type MailMessage,
  type MailProtocol,
  DEFAULT_VERIFICATION_PATTERN,
  errorMessage,
  exportAccounts,
  extractVerificationCode,
  fetchAccount,
  formatDateTime,
  hasTokenInvalidError,
  importAccounts,
  isTokenInvalidError,
  deleteAccount as deleteAccountApi,
  listAccounts,
  clearAllAccounts as clearAllAccountsApi,
  runWithConcurrency,
  sortMessages,
} from "./mail";
import { SiteAdCard } from "./SiteAdCard";
import siteLogo from "../src-tauri/icons/128x128.png";

const SETTINGS_STORAGE_KEY = "ccmtc-mail-settings-v1";
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const DEFAULT_BATCH_PAGE_SIZE = 10;
const DEFAULT_SINGLE_PAGE_SIZE = 20;

type Mode = "batch" | "single";
type ThemeMode = "light" | "dark";

type StoredSettings = {
  folder: MailFolder;
  threadCount: number;
  verificationPattern: string;
  batchPageSize: number;
  singlePageSize: number;
  theme: ThemeMode;
  adEnabled: boolean;
  adTitle: string;
  adDescription: string;
  adActionUrl: string;
};

function normalizePageSize(value: unknown, fallback: number) {
  const parsed = Number(value);
  return PAGE_SIZE_OPTIONS.includes(
    parsed as (typeof PAGE_SIZE_OPTIONS)[number],
  )
    ? parsed
    : fallback;
}

function readSettings(): StoredSettings {
  try {
    const value = JSON.parse(
      localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}",
    ) as Partial<StoredSettings>;
    return {
      folder: value.folder === "spam" ? "spam" : "inbox",
      threadCount: Math.max(1, Math.min(30, Number(value.threadCount) || 5)),
      verificationPattern:
        typeof value.verificationPattern === "string"
          ? value.verificationPattern
          : DEFAULT_VERIFICATION_PATTERN,
      batchPageSize: normalizePageSize(
        value.batchPageSize,
        DEFAULT_BATCH_PAGE_SIZE,
      ),
      singlePageSize: normalizePageSize(
        value.singlePageSize,
        DEFAULT_SINGLE_PAGE_SIZE,
      ),
      theme:
        value.theme === "dark" || value.theme === "light"
          ? value.theme
          : "dark",
      adEnabled: typeof value.adEnabled === "boolean" ? value.adEnabled : true,
      adTitle: typeof value.adTitle === "string" ? value.adTitle : "",
      adDescription: typeof value.adDescription === "string" ? value.adDescription : "",
      adActionUrl: typeof value.adActionUrl === "string" ? value.adActionUrl : "",
    };
  } catch {
    return {
      folder: "inbox",
      threadCount: 5,
      verificationPattern: DEFAULT_VERIFICATION_PATTERN,
      batchPageSize: DEFAULT_BATCH_PAGE_SIZE,
      singlePageSize: DEFAULT_SINGLE_PAGE_SIZE,
      theme: "dark",
      adEnabled: true,
      adTitle: "",
      adDescription: "",
      adActionUrl: "",
    };
  }
}

function messageKey(message: MailMessage) {
  return `${message.protocol}:${message.folder}:${message.id}`;
}

function ProtocolBadge({ protocol }: { protocol: MailProtocol }) {
  return (
    <span className={`protocol-badge protocol-${protocol}`}>
      {protocol === "graph" ? "Graph" : "IMAP"}
    </span>
  );
}

function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof InboxIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon size={22} />
      </div>
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}

function Pager({
  page,
  totalPages,
  total,
  pageSize,
  disabled = false,
  onChange,
  onPageSizeChange,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  disabled?: boolean;
  onChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}) {
  return (
    <div className="pager">
      <span>
        第 {page} / {totalPages} 页 · 共 {total} 条
      </span>
      <div className="pager-actions">
        <label className="page-size-field">
          <span>每页</span>
          <select
            value={pageSize}
            disabled={disabled}
            onChange={(event) => onPageSizeChange(Number(event.target.value))}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <button
          className="icon-button"
          disabled={disabled || page <= 1}
          onClick={() => onChange(page - 1)}
          aria-label="上一页"
        >
          <ChevronLeftIcon size={16} />
        </button>
        <button
          className="icon-button"
          disabled={disabled || page >= totalPages}
          onClick={() => onChange(page + 1)}
          aria-label="下一页"
        >
          <ChevronRightIcon size={16} />
        </button>
      </div>
    </div>
  );
}

function FetchToolbar({
  folder,
  accountCount,
  onFolderChange,
  children,
}: {
  folder: MailFolder;
  accountCount?: number;
  onFolderChange: (folder: MailFolder) => void;
  children?: ReactNode;
}) {
  return (
    <div className="embedded-controls">
      <div className="control-group">
        <span className="control-label">文件夹</span>
        <div className="mini-switch">
          <button
            className={folder === "inbox" ? "active" : ""}
            onClick={() => onFolderChange("inbox")}
          >
            <InboxIcon size={13} />
            收件箱
          </button>
          <button
            className={folder === "spam" ? "active" : ""}
            onClick={() => onFolderChange("spam")}
          >
            <ArchiveIcon size={13} />
            垃圾箱
          </button>
        </div>
      </div>

      {typeof accountCount === "number" ? (
        <div className="account-count">
          <UsersIcon size={15} />
          {accountCount} 个账号
        </div>
      ) : null}

      {children ? <div className="embedded-actions">{children}</div> : null}
    </div>
  );
}

function MessageDialog({
  context,
  verificationPattern,
  onClose,
}: {
  context: { account: MailAccount; message: MailMessage } | null;
  verificationPattern: string;
  onClose: () => void;
}) {
  if (!context) {
    return null;
  }
  const { account, message } = context;
  const code = extractVerificationCode(message, verificationPattern);
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="dialog-card mail-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div className="dialog-heading">
            <div className="dialog-title-row">
              <ProtocolBadge protocol={message.protocol} />
              <span>{account.email}</span>
            </div>
            <h2>{message.subject || "(无主题)"}</h2>
            <p>
              {message.sender} · {formatDateTime(message.received_at)}
            </p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <XIcon size={18} />
          </button>
        </header>

        {code ? (
          <div className="verification-strip">
            <span>识别到验证码</span>
            <strong>{code}</strong>
            <button
              className="button button-soft button-small"
              onClick={() => {
                void navigator.clipboard.writeText(code);
                toast.success("验证码已复制");
              }}
            >
              <CopyIcon size={13} />
              复制
            </button>
          </div>
        ) : null}

        <div className="mail-body-host">
          {message.body_type === "html" ? (
            <iframe
              title="邮件正文"
              sandbox="allow-popups"
              srcDoc={message.body}
            />
          ) : (
            <pre>{message.body || message.preview || "暂无正文内容"}</pre>
          )}
        </div>
      </section>
    </div>
  );
}

function ImportDialog({
  open,
  value,
  onValueChange,
  onClose,
  onSubmit,
}: {
  open: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  if (!open) {
    return null;
  }
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="dialog-card import-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div className="dialog-heading">
            <span className="eyebrow">账号管理</span>
            <h2>手动导入 Outlook OAuth 账号</h2>
            <p>仅保存在当前电脑。支持 TXT 文件或直接粘贴文本。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <XIcon size={18} />
          </button>
        </header>
        <form onSubmit={onSubmit} className="import-form">
          <input
            ref={inputRef}
            hidden
            type="file"
            accept=".txt,text/plain"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (!file) return;
              void file.text().then((text) => {
                onValueChange(text);
                toast.success(`已读取 ${file.name}`);
              });
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="file-drop"
            onClick={() => inputRef.current?.click()}
          >
            <UploadIcon size={18} />
            <span>
              <strong>选择 TXT 文件</strong>
              <small>文件内容会载入下方文本框，可确认后再导入</small>
            </span>
          </button>
          <label className="field-label" htmlFor="account-import-text">
            账号文本
          </label>
          <textarea
            id="account-import-text"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            rows={12}
            spellCheck={false}
            placeholder="account@example.com--------client_id----refresh_token"
          />
          <p className="form-hint">
            一行一个账号，格式：邮箱----密码（留空）----Client ID----Refresh Token
            <br />
            <small>密码字段仅作占位，OAuth 不需要密码</small>
          </p>
          <footer className="dialog-footer">
            <button
              type="button"
              className="button button-soft"
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="button button-primary">
              <PlusIcon size={15} />
              导入账号
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function RegexDialog({
  open,
  value,
  onValueChange,
  onClose,
  onSave,
}: {
  open: boolean;
  value: string;
  onValueChange: (value: string) => void;
  onClose: () => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section
        className="dialog-card regex-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="dialog-header">
          <div className="dialog-heading">
            <span className="eyebrow">Batch mailbox</span>
            <h2>验证码正则表达式</h2>
            <p>依次匹配邮件主题、摘要和正文，优先返回第一个捕获组。</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="关闭">
            <XIcon size={18} />
          </button>
        </header>
        <form className="regex-form" onSubmit={onSave}>
          <label className="field-label" htmlFor="verification-pattern">
            正则表达式
          </label>
          <textarea
            id="verification-pattern"
            value={value}
            onChange={(event) => onValueChange(event.target.value)}
            rows={6}
            spellCheck={false}
          />
          <p className="form-hint">
            示例：{String.raw`验证码[^\d]{0,12}(\d{6})`}
          </p>
          <footer className="dialog-footer">
            <button
              type="button"
              className="button button-ghost regex-reset"
              onClick={() => onValueChange(DEFAULT_VERIFICATION_PATTERN)}
            >
              恢复默认
            </button>
            <button
              type="button"
              className="button button-soft"
              onClick={onClose}
            >
              取消
            </button>
            <button type="submit" className="button button-primary">
              保存正则
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export default function App() {
  const initialSettings = useMemo(readSettings, []);
  const [accounts, setAccounts] = useState<MailAccount[]>([]);
  const [mode, setMode] = useState<Mode>("batch");
  const [folder, setFolder] = useState<MailFolder>(initialSettings.folder);
  const [threadCount, setThreadCount] = useState(initialSettings.threadCount);
  const [verificationPattern, setVerificationPattern] = useState(
    initialSettings.verificationPattern,
  );
  const [batchPageSize, setBatchPageSize] = useState(
    initialSettings.batchPageSize,
  );
  const [singlePageSize, setSinglePageSize] = useState(
    initialSettings.singlePageSize,
  );
  const [theme, setTheme] = useState<ThemeMode>(initialSettings.theme);
  const [adEnabled, setAdEnabled] = useState(initialSettings.adEnabled);
  const [adTitle, setAdTitle] = useState(initialSettings.adTitle);
  const [adDescription, setAdDescription] = useState(initialSettings.adDescription);
  const [adActionUrl, setAdActionUrl] = useState(initialSettings.adActionUrl);
  const [adSettingsOpen, setAdSettingsOpen] = useState(false);
  const [adTitleDraft, setAdTitleDraft] = useState(initialSettings.adTitle);
  const [adDescriptionDraft, setAdDescriptionDraft] = useState(initialSettings.adDescription);
  const [adActionUrlDraft, setAdActionUrlDraft] = useState(initialSettings.adActionUrl);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [regexOpen, setRegexOpen] = useState(false);
  const [regexDraft, setRegexDraft] = useState(verificationPattern);
  const [query, setQuery] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [batchRows, setBatchRows] = useState<BatchRow[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchPage, setBatchPage] = useState(1);
  const [batchStatusFilter, setBatchStatusFilter] =
    useState<BatchStatusFilter>("all");
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(
    new Set(),
  );
  const [rowFetchingIds, setRowFetchingIds] = useState<Set<string>>(
    new Set(),
  );
  const [singleResult, setSingleResult] = useState<AccountFetchResult | null>(
    null,
  );
  const [singleLoading, setSingleLoading] = useState(false);
  const [singlePage, setSinglePage] = useState(1);
  const [dialogContext, setDialogContext] = useState<{
    account: MailAccount;
    message: MailMessage;
  } | null>(null);
  const [adSlot, setAdSlot] = useState<AdSlotConfig | null>(null);

  // 本地广告配置：启用且有标题时才展示
  useEffect(() => {
    if (adEnabled && adTitle.trim()) {
      setAdSlot({
        enabled: true,
        title: adTitle,
        description: adDescription,
        image_url: "",
        image_alt: "",
        primary_action: { label: "查看详情", href: adActionUrl },
      });
    } else {
      setAdSlot(null);
    }
  }, [adEnabled, adTitle, adDescription, adActionUrl]);

  // 打开设置时同步草稿
  useEffect(() => {
    setAdTitleDraft(adTitle);
    setAdDescriptionDraft(adDescription);
    setAdActionUrlDraft(adActionUrl);
  }, [adSettingsOpen]);

  // Load accounts from backend on mount
  useEffect(() => {
    listAccounts()
      .then((loaded) => {
        setAccounts(loaded);
        if (loaded.length > 0) {
          setSelectedAccountId(loaded[0].id);
        }
      })
      .catch(() => setAccounts([]));
  }, []);

  useEffect(() => {
    setSelectedAccountId((current) =>
      accounts.some((account) => account.id === current)
        ? current
        : accounts[0]?.id || "",
    );
    setBatchRows((current) => {
      const existingRows = new Map(current.map((row) => [row.account.id, row]));
      return accounts.map((account) => {
        const existing = existingRows.get(account.id);
        if (existing) {
          return { ...existing, account };
        }
        return {
          account,
          message: null,
          verificationCode: "",
          errors: [],
          completed: false,
          successfulProtocolCount: 0,
          tokenInvalid: false,
        };
      });
    });
  }, [accounts]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    const themeColor = document.querySelector('meta[name="theme-color"]');
    themeColor?.setAttribute(
      "content",
      theme === "dark" ? "#0e0c1f" : "#1b1938",
    );
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        folder,
        threadCount,
        verificationPattern,
        batchPageSize,
        singlePageSize,
        theme,
        adEnabled,
        adTitle,
        adDescription,
        adActionUrl,
      }),
    );
  }, [
    batchPageSize,
    folder,
    singlePageSize,
    theme,
    threadCount,
    verificationPattern,
    adEnabled,
    adTitle,
    adDescription,
    adActionUrl,
  ]);

  const selectedAccount = useMemo(
    () => accounts.find((account) => account.id === selectedAccountId) || null,
    [accounts, selectedAccountId],
  );
  const filteredAccounts = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return accounts;
    return accounts.filter((account) =>
      account.email.toLowerCase().includes(keyword),
    );
  }, [accounts, query]);

  // Filter batch rows by status
  const filteredBatchRows = useMemo(() => {
    if (batchStatusFilter === "all") return batchRows;
    return batchRows.filter((row) => {
      const hasError =
        row.successfulProtocolCount === 0 &&
        row.errors.length > 0 &&
        !row.message;
      const hasSuccess = row.message !== null;
      const isPending = !row.completed;

      switch (batchStatusFilter) {
        case "success":
          return hasSuccess;
        case "error":
          return hasError;
        case "pending":
          return isPending;
        default:
          return true;
      }
    });
  }, [batchRows, batchStatusFilter]);

  const batchTotalPages = Math.max(
    1,
    Math.ceil(filteredBatchRows.length / batchPageSize),
  );
  const visibleBatchRows = filteredBatchRows.slice(
    (batchPage - 1) * batchPageSize,
    batchPage * batchPageSize,
  );
  const singleMessages = singleResult?.messages || [];
  const singleTotal = singleResult?.total || 0;
  const singleTotalPages = Math.max(1, Math.ceil(singleTotal / singlePageSize));
  const visibleSingleMessages = singleMessages;

  // Batch statistics
  const batchStats = useMemo(() => {
    const total = batchRows.length;
    const success = batchRows.filter((row) => row.message !== null).length;
    const error = batchRows.filter(
      (row) =>
        row.successfulProtocolCount === 0 &&
        row.errors.length > 0 &&
        !row.message,
    ).length;
    const tokenInvalid = batchRows.filter((row) => row.tokenInvalid).length;
    const pending = batchRows.filter((row) => !row.completed).length;
    return { total, success, error, pending, tokenInvalid };
  }, [batchRows]);

  useEffect(() => {
    setBatchPage((current) => Math.min(current, batchTotalPages));
  }, [batchTotalPages]);

  useEffect(() => {
    setSinglePage((current) => Math.min(current, singleTotalPages));
  }, [singleTotalPages]);

  async function handleImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const imported = await importAccounts(importText);
      if (!imported.length) {
        toast.error("没有解析到有效账号", {
          description: "请检查邮箱----密码----Client ID----Refresh Token 格式。",
        });
        return;
      }
      // Reload all accounts from backend to get complete list
      const allAccounts = await listAccounts();
      setAccounts(allAccounts);
      setSelectedAccountId(imported[0].id);
      setBatchRows([]);
      setSingleResult(null);
      setImportText("");
      setImportOpen(false);
      toast.success(`已导入 ${imported.length} 个账号`, {
        description: "凭据已加密存储在本地。",
      });
    } catch (error) {
      toast.error("导入失败", { description: errorMessage(error) });
    }
  }

  async function handleExport() {
    try {
      const filePath = await save({
        defaultPath: `mail-accounts-${new Date().toISOString().slice(0, 10)}.txt`,
        filters: [{ name: "文本文件", extensions: ["txt"] }],
      });
      if (!filePath) return;
      // 勾选了行时只导出选中账号；未勾选时导出全部（向后兼容）
      const selectedIds =
        selectedBatchIds.size > 0 ? Array.from(selectedBatchIds) : undefined;
      const savedPath = await exportAccounts(filePath, selectedIds);
      toast.success(
        selectedIds ? `已导出选中的 ${selectedIds.length} 个账号` : "账号已导出",
        {
          description: `已保存到：${savedPath}`,
        },
      );
    } catch (error) {
      toast.error("导出失败", { description: errorMessage(error) });
    }
  }

  function handleRegexSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      new RegExp(regexDraft, "i");
    } catch (error) {
      toast.error("验证码正则表达式无效", {
        description: errorMessage(error),
      });
      return;
    }
    setVerificationPattern(regexDraft);
    setBatchRows((current) =>
      current.map((row) => ({
        ...row,
        verificationCode: extractVerificationCode(row.message, regexDraft),
      })),
    );
    setRegexOpen(false);
    toast.success("验证码正则已保存");
  }

  async function handleBatchFetch() {
    try {
      new RegExp(verificationPattern, "i");
    } catch (error) {
      toast.error("验证码正则表达式无效", {
        description: errorMessage(error),
      });
      return;
    }
    if (!accounts.length) {
      toast.error("请先导入账号");
      setImportOpen(true);
      return;
    }
    const pageStart = (batchPage - 1) * batchPageSize;
    const pageAccounts = filteredBatchRows
      .slice(pageStart, pageStart + batchPageSize)
      .map((row) => row.account);
    if (!pageAccounts.length) {
      toast.info("当前页没有可读取的账号");
      return;
    }
    setBatchLoading(true);
    const pageAccountIds = new Set(pageAccounts.map((account) => account.id));
    setBatchRows((current) =>
      current.map((row) =>
        pageAccountIds.has(row.account.id)
          ? {
              ...row,
              message: null,
              verificationCode: "",
              errors: [],
              completed: false,
              successfulProtocolCount: 0,
              tokenInvalid: false,
            }
          : row,
      ),
    );
    try {
      const results = await runWithConcurrency(
        pageAccounts,
        threadCount,
        async (account) => {
          const result = await fetchAccount(account, folder, 1);
          const message = result.messages[0] || null;
          const row: BatchRow = {
            account,
            message,
            verificationCode: extractVerificationCode(
              message,
              verificationPattern,
            ),
            errors: result.errors,
            completed: true,
            successfulProtocolCount: result.successfulProtocols.length,
            tokenInvalid: hasTokenInvalidError(result.errors),
          };
          setBatchRows((current) =>
            current.map((item) =>
              item.account.id === account.id ? row : item,
            ),
          );
          return result;
        },
      );
      const successCount = results.filter(
        (result) => result.messages.length,
      ).length;
      const tokenInvalidCount = results.filter((result) =>
        hasTokenInvalidError(result.errors),
      ).length;
      toast.success("批量取件完成", {
        description: `当前页 ${successCount}/${pageAccounts.length} 个账号获取到邮件。${
          tokenInvalidCount
            ? `另有 ${tokenInvalidCount} 个账号令牌失效。`
            : ""
        }`,
      });
    } catch (error) {
      toast.error("批量取件失败", { description: errorMessage(error) });
    } finally {
      setBatchLoading(false);
    }
  }

  // 列表页行级操作：单个邮箱取件并识别验证码
  async function handleRowFetch(accountId: string) {
    const account = accounts.find((item) => item.id === accountId);
    if (!account || batchLoading) {
      return;
    }
    setRowFetchingIds((current) => new Set(current).add(accountId));
    try {
      // 抓取 5 封（按时间倒序），优先找到含验证码的那一封
      const result = await fetchAccount(account, folder, 5);
      const messages = sortMessages(result.messages);
      const codedMessage =
        messages.find(
          (message) =>
            extractVerificationCode(message, verificationPattern) !== "",
        ) || null;
      const code = codedMessage
        ? extractVerificationCode(codedMessage, verificationPattern)
        : "";
      const tokenInvalid = hasTokenInvalidError(result.errors);
      setBatchRows((current) =>
        current.map((row) =>
          row.account.id === accountId
            ? {
                ...row,
                message: messages[0] || null,
                verificationCode: code,
                errors: result.errors,
                completed: true,
                successfulProtocolCount: result.successfulProtocols.length,
                tokenInvalid,
              }
            : row,
        ),
      );
      if (tokenInvalid) {
        toast.error("取件失败：令牌可能已失效", {
          description: `${account.email} 需要重新授权后才能取件。`,
        });
      } else if (code) {
        toast.success("已获取验证码", {
          description: `${account.email} → ${code}`,
        });
      } else if (result.errors.length) {
        toast.error("取件失败", {
          description: result.errors
            .map((item) => `${item.protocol}: ${item.message}`)
            .join("；"),
        });
      } else if (result.messages.length) {
        toast.info("取件成功，未识别到验证码", {
          description: `${account.email} 最近 ${result.messages.length} 封邮件中未匹配到验证码。`,
        });
      } else {
        toast.info("取件成功，当前文件夹暂无邮件", {
          description: account.email,
        });
      }
    } catch (error) {
      setBatchRows((current) =>
        current.map((row) =>
          row.account.id === accountId
            ? {
                ...row,
                errors: [
                  { protocol: "graph", message: errorMessage(error) },
                  { protocol: "imap", message: errorMessage(error) },
                ],
                completed: true,
                successfulProtocolCount: 0,
                tokenInvalid: isTokenInvalidError(errorMessage(error)),
              }
            : row,
        ),
      );
      toast.error("取件失败", { description: errorMessage(error) });
    } finally {
      setRowFetchingIds((current) => {
        const next = new Set(current);
        next.delete(accountId);
        return next;
      });
    }
  }

  async function handleSingleFetch(
    account = selectedAccount,
    page = singlePage,
    pageSize = singlePageSize,
  ) {
    if (!account) {
      toast.error("请选择邮箱账号");
      return;
    }
    const safePage = Math.max(1, page);
    const offset = (safePage - 1) * pageSize;
    setSingleLoading(true);
    setSinglePage(safePage);
    setSingleResult((current) =>
      current?.account.id === account.id ? { ...current, messages: [] } : null,
    );
    try {
      const result = await fetchAccount(account, folder, pageSize, offset);
      setSingleResult(result);
      if (result.messages.length) {
        toast.success(
          `第 ${safePage} 页已获取 ${result.messages.length} 封邮件`,
        );
      } else if (result.errors.length) {
        toast.error("取件失败", {
          description: result.errors
            .map((item) => `${item.protocol}: ${item.message}`)
            .join("；"),
        });
      } else {
        toast.info("取件成功，当前文件夹暂无邮件");
      }
    } catch (error) {
      toast.error("取件失败", { description: errorMessage(error) });
    } finally {
      setSingleLoading(false);
    }
  }

  async function handleDeleteAccount(accountId: string) {
    try {
      await deleteAccountApi(accountId);
      setAccounts((current) =>
        current.filter((account) => account.id !== accountId),
      );
      setBatchRows((current) =>
        current.filter((row) => row.account.id !== accountId),
      );
      setSelectedBatchIds((current) => {
        const next = new Set(current);
        next.delete(accountId);
        return next;
      });
      if (singleResult?.account.id === accountId) {
        setSingleResult(null);
      }
    } catch (error) {
      toast.error("删除账号失败", { description: errorMessage(error) });
    }
  }

  async function handleBatchDelete() {
    if (selectedBatchIds.size === 0) {
      toast.info("请先选择要删除的账号");
      return;
    }
    const ids = Array.from(selectedBatchIds);
    const count = ids.length;
    const confirmed = await ask(`确定删除选中的 ${count} 个账号吗？`, {
      title: "确认删除",
      kind: "warning",
    });
    if (!confirmed) {
      return;
    }
    try {
      const results = await Promise.allSettled(
        ids.map((id) => deleteAccountApi(id)),
      );
      const succeededIds = new Set(
        ids.filter((_, i) => results[i].status === "fulfilled"),
      );
      const failedCount = count - succeededIds.size;
      setAccounts((current) =>
        current.filter((account) => !succeededIds.has(account.id)),
      );
      setBatchRows((current) =>
        current.filter((row) => !succeededIds.has(row.account.id)),
      );
      setSelectedBatchIds(new Set());
      if (singleResult && succeededIds.has(singleResult.account.id)) {
        setSingleResult(null);
      }
      if (failedCount > 0) {
        toast.error("批量删除部分失败", {
          description: `成功 ${succeededIds.size} 个，失败 ${failedCount} 个。`,
        });
      } else {
        toast.success(`已删除 ${count} 个账号`);
      }
    } catch (error) {
      toast.error("批量删除失败", { description: errorMessage(error) });
    }
  }

  function toggleBatchSelect(accountId: string) {
    setSelectedBatchIds((current) => {
      const next = new Set(current);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedBatchIds.size === visibleBatchRows.length) {
      setSelectedBatchIds(new Set());
    } else {
      setSelectedBatchIds(new Set(visibleBatchRows.map((row) => row.account.id)));
    }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <img src={siteLogo} alt="CCMTC" />
          </div>
          <div>
            <strong>Mail</strong>
            <span>Outlook OAuth 桌面取件</span>
            </div>
            </div>

            {adSettingsOpen ? (
            <div className="dialog-backdrop" onClick={() => setAdSettingsOpen(false)}>
              <section
                className="dialog-card ad-settings-dialog"
                onClick={(e) => e.stopPropagation()}
              >
                <header className="dialog-header">
                  <h2>广告设置</h2>
                  <button
                    className="icon-button"
                    onClick={() => setAdSettingsOpen(false)}
                  >
                    <XIcon size={18} />
                  </button>
                </header>
                <div className="ad-settings-form">
                  <label className="ad-settings-checkbox">
                    <input
                      type="checkbox"
                      checked={adEnabled}
                      onChange={(e) => setAdEnabled(e.target.checked)}
                    />
                    <span>启用站点广告</span>
                  </label>
                  <label className="ad-settings-field">
                    <span className="ad-settings-field-label">店铺名称</span>
                    <input
                      type="text"
                      className="ad-settings-input"
                      value={adTitleDraft}
                      onChange={(e) => setAdTitleDraft(e.target.value)}
                      placeholder="例如：CCMTC 云服务"
                      disabled={!adEnabled}
                    />
                  </label>
                  <label className="ad-settings-field">
                    <span className="ad-settings-field-label">广告描述</span>
                    <input
                      type="text"
                      className="ad-settings-input"
                      value={adDescriptionDraft}
                      onChange={(e) => setAdDescriptionDraft(e.target.value)}
                      placeholder="例如：高速稳定，全球节点，即开即用"
                      disabled={!adEnabled}
                    />
                  </label>
                  <label className="ad-settings-field">
                    <span className="ad-settings-field-label">跳转链接</span>
                    <input
                      type="text"
                      className="ad-settings-input"
                      value={adActionUrlDraft}
                      onChange={(e) => setAdActionUrlDraft(e.target.value)}
                      placeholder="https://your-site.com"
                      disabled={!adEnabled}
                    />
                  </label>
                </div>
                <footer className="dialog-footer">
                  <button
                    className="button button-ghost"
                    onClick={() => {
                      setAdTitleDraft(adTitle);
                      setAdDescriptionDraft(adDescription);
                      setAdActionUrlDraft(adActionUrl);
                      setAdSettingsOpen(false);
                    }}
                  >
                    取消
                  </button>
                  <button
                    className="button button-primary"
                    onClick={() => {
                      setAdTitle(adTitleDraft);
                      setAdDescription(adDescriptionDraft);
                      setAdActionUrl(adActionUrlDraft);
                      setAdSettingsOpen(false);
                    }}
                  >
                    保存
                  </button>
                </footer>
              </section>
            </div>
            ) : null}

            {adSlot ? (
          <div className="topbar-ad">
            <SiteAdCard config={adSlot} compact />
          </div>
        ) : (
          <div className="topbar-spacer" />
        )}

        <div className="topbar-actions">
          <div className="mode-switch" aria-label="取件模式">
            <button
              className={mode === "batch" ? "active" : ""}
              onClick={() => setMode("batch")}
            >
              <TablePropertiesIcon size={15} />
              批量取件
            </button>
            <button
              className={mode === "single" ? "active" : ""}
              onClick={() => setMode("single")}
            >
              <LayoutListIcon size={15} />
              单邮箱
            </button>
          </div>
          <button
            className="icon-button"
            onClick={() =>
              setTheme((value) => (value === "dark" ? "light" : "dark"))
            }
            aria-label="切换主题"
          >
            {theme === "dark" ? <SunIcon size={17} /> : <MoonIcon size={17} />}
          </button>
          <button
            className="icon-button"
            onClick={() => setAdSettingsOpen(true)}
            aria-label="广告设置"
            title={adEnabled ? "广告设置" : "广告已关闭"}
          >
            <SettingsIcon size={17} />
          </button>
          <button
            className="button button-soft"
            onClick={() => void handleExport()}
          >
            <DownloadIcon size={15} />
            导出
          </button>
          <button
            className="button button-primary"
            onClick={() => setImportOpen(true)}
          >
            <PlusIcon size={15} />
            导入账号
          </button>
        </div>
      </header>

      <div className="app-content">
        {mode === "batch" ? (
          <section className="workspace-card batch-workspace">
            <header className="workspace-toolbar-header">
              <FetchToolbar
                folder={folder}
                accountCount={accounts.length}
                onFolderChange={setFolder}
              >
                <button
                  className="button button-soft"
                  onClick={() => {
                    setRegexDraft(verificationPattern);
                    setRegexOpen(true);
                  }}
                >
                  <FileTextIcon size={14} />
                  验证码正则
                </button>
                <label className="thread-field">
                  <span>取件线程</span>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    value={threadCount}
                    onChange={(event) =>
                      setThreadCount(
                        Math.max(
                          1,
                          Math.min(30, Number(event.target.value) || 1),
                        ),
                      )
                    }
                  />
                </label>
                <button
                  className="button button-primary"
                  onClick={() => void handleBatchFetch()}
                  disabled={batchLoading}
                >
                  {batchLoading ? (
                    <LoaderCircleIcon className="spin" size={15} />
                  ) : (
                    <PlayIcon size={15} />
                  )}
                  {batchLoading ? "取件中" : "读取当前页"}
                </button>
              </FetchToolbar>
            </header>

            {/* Batch statistics and filters */}
            <div className="batch-stats-bar">
              <div className="batch-stats">
                <span className="stat-item">
                  总计 <strong>{batchStats.total}</strong>
                </span>
                <span className="stat-item stat-success">
                  成功 <strong>{batchStats.success}</strong>
                </span>
                <span className="stat-item stat-error">
                  失败 <strong>{batchStats.error}</strong>
                </span>
                <span className="stat-item stat-pending">
                  待取件 <strong>{batchStats.pending}</strong>
                </span>
                <span className="stat-item stat-error">
                  失效 <strong>{batchStats.tokenInvalid}</strong>
                </span>
              </div>
              <div className="batch-filters">
                <div className="mini-switch">
                  <button
                    className={batchStatusFilter === "all" ? "active" : ""}
                    onClick={() => setBatchStatusFilter("all")}
                  >
                    全部
                  </button>
                  <button
                    className={batchStatusFilter === "success" ? "active" : ""}
                    onClick={() => setBatchStatusFilter("success")}
                  >
                    成功
                  </button>
                  <button
                    className={batchStatusFilter === "error" ? "active" : ""}
                    onClick={() => setBatchStatusFilter("error")}
                  >
                    失败
                  </button>
                  <button
                    className={batchStatusFilter === "pending" ? "active" : ""}
                    onClick={() => setBatchStatusFilter("pending")}
                  >
                    待取件
                  </button>
                </div>
                {selectedBatchIds.size > 0 ? (
                  <button
                    className="button button-soft button-danger"
                    onClick={() => void handleBatchDelete()}
                  >
                    <Trash2Icon size={14} />
                    删除选中 ({selectedBatchIds.size})
                  </button>
                ) : null}
              </div>
            </div>

            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <th className="checkbox-column">
                      <input
                        type="checkbox"
                        checked={
                          visibleBatchRows.length > 0 &&
                          selectedBatchIds.size === visibleBatchRows.length
                        }
                        onChange={toggleSelectAll}
                        aria-label="全选"
                      />
                    </th>
                    <th className="index-column">#</th>
                    <th>邮箱</th>
                    <th>最新邮件</th>
                    <th>验证码</th>
                    <th>时间</th>
                    <th className="status-column">状态</th>
                    <th className="actions-column">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleBatchRows.length ? (
                    visibleBatchRows.map((row, index) => {
                      const absoluteIndex =
                        (batchPage - 1) * batchPageSize + index + 1;
                      const hasError =
                        row.successfulProtocolCount === 0 &&
                        row.errors.length > 0 &&
                        !row.message;
                      const completedWithoutMail =
                        row.completed && !row.message && !hasError;
                      return (
                        <tr
                          key={row.account.id}
                          className={row.message ? "clickable-row" : ""}
                          onClick={() =>
                            row.message &&
                            setDialogContext({
                              account: row.account,
                              message: row.message,
                            })
                          }
                        >
                          <td className="checkbox-cell">
                            <input
                              type="checkbox"
                              checked={selectedBatchIds.has(row.account.id)}
                              onChange={(event) => {
                                event.stopPropagation();
                                toggleBatchSelect(row.account.id);
                              }}
                              onClick={(event) => event.stopPropagation()}
                              aria-label={`选择 ${row.account.email}`}
                            />
                          </td>
                          <td className="index-cell">{absoluteIndex}</td>
                          <td>
                            <div className="email-cell">
                              <span className="mail-avatar">
                                {row.account.email.slice(0, 1).toUpperCase()}
                              </span>
                              <div>
                                <strong>{row.account.email}</strong>
                                <small>
                                  {row.message ? (
                                    <ProtocolBadge
                                      protocol={row.message.protocol}
                                    />
                                  ) : row.completed ? (
                                    hasError ? (
                                      "取件失败"
                                    ) : (
                                      "暂无邮件"
                                    )
                                  ) : (
                                    "等待结果"
                                  )}
                                </small>
                                {row.tokenInvalid ? (
                                  <span className="token-invalid-badge">
                                    <CircleAlertIcon size={10} />
                                    令牌失效
                                  </span>
                                ) : null}
                              </div>
                            </div>
                          </td>
                          <td>
                            {row.message ? (
                              <div className="subject-cell">
                                <strong>
                                  {row.message.subject || "(无主题)"}
                                </strong>
                                <small>
                                  {row.message.preview || "暂无正文摘要"}
                                </small>
                              </div>
                            ) : (
                              <span className="muted-text">
                                {hasError
                                  ? row.errors
                                      .map((item) => item.message)
                                      .join("；")
                                  : !row.completed && batchLoading
                                    ? "正在取件..."
                                    : "暂无邮件"}
                              </span>
                            )}
                          </td>
                          <td>
                            {row.verificationCode ? (
                              <button
                                className="code-pill"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void navigator.clipboard.writeText(
                                    row.verificationCode,
                                  );
                                  toast.success("验证码已复制");
                                }}
                              >
                                {row.verificationCode}
                                <CopyIcon size={12} />
                              </button>
                            ) : (
                              <span className="muted-text">—</span>
                            )}
                          </td>
                          <td className="time-cell">
                            {row.message
                              ? formatDateTime(row.message.received_at)
                              : "—"}
                          </td>
                          <td>
                            <span
                              className={`status-dot ${
                                row.tokenInvalid
                                  ? "error"
                                  : row.message
                                    ? "success"
                                    : hasError
                                      ? "error"
                                      : completedWithoutMail
                                        ? "success"
                                        : "idle"
                              }`}
                            >
                              {row.tokenInvalid ? (
                                <CircleAlertIcon size={13} />
                              ) : row.message ? (
                                <CheckCircle2Icon size={13} />
                              ) : hasError ? (
                                <CircleAlertIcon size={13} />
                              ) : completedWithoutMail ? (
                                <CheckCircle2Icon size={13} />
                              ) : (
                                <LoaderCircleIcon
                                  className={batchLoading ? "spin" : ""}
                                  size={13}
                                />
                              )}
                              {row.tokenInvalid
                                ? "令牌失效"
                                : row.message
                                  ? "成功"
                                  : hasError
                                    ? "失败"
                                    : completedWithoutMail
                                      ? "无邮件"
                                      : "待取件"}
                            </span>
                          </td>
                          <td className="actions-cell">
                            <button
                              className="row-fetch-button"
                              disabled={
                                batchLoading ||
                                rowFetchingIds.has(row.account.id)
                              }
                              title="获取该邮箱最新邮件并识别验证码"
                              onClick={(event) => {
                                event.stopPropagation();
                                void handleRowFetch(row.account.id);
                              }}
                            >
                              {rowFetchingIds.has(row.account.id) ? (
                                <LoaderCircleIcon
                                  className="spin"
                                  size={13}
                                />
                              ) : (
                                <KeyRoundIcon size={13} />
                              )}
                              {rowFetchingIds.has(row.account.id)
                                ? "取件中"
                                : "取验证码"}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={8}>
                        <EmptyState
                          icon={TablePropertiesIcon}
                          title="还没有批量取件结果"
                          description="导入账号后，设置协议和线程数开始取件。"
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <Pager
              page={batchPage}
              totalPages={batchTotalPages}
              total={filteredBatchRows.length}
              pageSize={batchPageSize}
              disabled={batchLoading}
              onChange={setBatchPage}
              onPageSizeChange={(size) => {
                setBatchPageSize(size);
                setBatchPage(1);
              }}
            />
          </section>
        ) : (
          <section className="single-layout">
            <aside className="workspace-card account-sidebar">
              <header className="sidebar-header">
                <div>
                  <span className="eyebrow">Accounts</span>
                  <h2>邮箱列表</h2>
                </div>
                <span className="sidebar-account-count">
                  <UsersIcon size={13} />
                  {accounts.length}
                </span>
              </header>
              <label className="search-field">
                <SearchIcon size={14} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索邮箱"
                />
              </label>
              <div className="account-list">
                {filteredAccounts.length ? (
                  filteredAccounts.map((account) => (
                    <button
                      key={account.id}
                      className={`account-item ${selectedAccountId === account.id ? "active" : ""}`}
                      onClick={() => {
                        setSelectedAccountId(account.id);
                        setSinglePage(1);
                        setSingleResult(null);
                      }}
                    >
                      <span className="mail-avatar">
                        {account.email.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="account-copy">
                        <strong>{account.email}</strong>
                        <small>OAuth 账号</small>
                      </span>
                      <span
                        role="button"
                        tabIndex={0}
                        className="account-delete"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleDeleteAccount(account.id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter")
                            void handleDeleteAccount(account.id);
                        }}
                      >
                        <Trash2Icon size={14} />
                      </span>
                    </button>
                  ))
                ) : (
                  <EmptyState
                    icon={UsersIcon}
                    title="暂无账号"
                    description="请点击顶部的导入账号按钮"
                  />
                )}
              </div>
              {accounts.length ? (
                <button
                  className="button button-ghost clear-button"
                  onClick={async () => {
                    const confirmed = await ask("确定清空所有本地账号吗？", {
                      title: "确认清空",
                      kind: "warning",
                    });
                    if (confirmed) {
                      clearAllAccountsApi()
                        .then(() => {
                          setAccounts([]);
                          setBatchRows([]);
                          setSingleResult(null);
                        })
                        .catch((error) => {
                          toast.error("清空失败", {
                            description: errorMessage(error),
                          });
                        });
                    }
                  }}
                >
                  <Trash2Icon size={14} />
                  清空全部
                </button>
              ) : null}
            </aside>

            <section className="workspace-card single-workspace">
              <header className="workspace-header single-header">
                <div className="single-mailbox-title">
                  <span className="eyebrow">Single mailbox</span>
                  <h1>{selectedAccount?.email || "选择一个邮箱"}</h1>
                  <p>左侧选择账号，右侧查看邮件。</p>
                </div>
                <div className="single-fetch-toolbar">
                  <FetchToolbar
                    folder={folder}
                    onFolderChange={setFolder}
                  >
                    <button
                      className="button button-primary"
                      disabled={!selectedAccount || singleLoading}
                      onClick={() => void handleSingleFetch()}
                    >
                      {singleLoading ? (
                        <LoaderCircleIcon className="spin" size={15} />
                      ) : (
                        <RefreshCwIcon size={15} />
                      )}
                      {singleLoading ? "取件中" : "刷新邮件"}
                    </button>
                  </FetchToolbar>
                </div>
              </header>

              {singleResult?.errors.length ? (
                <div className="inline-alert">
                  <CircleAlertIcon size={15} />
                  <span>
                    {singleResult.errors
                      .map((item) => `${item.protocol}: ${item.message}`)
                      .join("；")}
                  </span>
                </div>
              ) : null}

              {singleResult && hasTokenInvalidError(singleResult.errors) ? (
                <div className="inline-alert inline-alert-danger">
                  <CircleAlertIcon size={15} />
                  <span>检测到该邮箱令牌失效，请重新授权后再取件。</span>
                </div>
              ) : null}

              <div className="message-list">
                {visibleSingleMessages.length ? (
                  visibleSingleMessages.map((message) => {
                    const code = extractVerificationCode(
                      message,
                      verificationPattern,
                    );
                    return (
                      <button
                        key={messageKey(message)}
                        className="message-item"
                        onClick={() =>
                          selectedAccount &&
                          setDialogContext({
                            account: selectedAccount,
                            message,
                          })
                        }
                      >
                        <span className="message-icon">
                          <MailIcon size={16} />
                        </span>
                        <span className="message-main">
                          <span className="message-title-row">
                            <strong>{message.subject || "(无主题)"}</strong>
                            <span>{formatDateTime(message.received_at)}</span>
                          </span>
                          <span className="message-meta">
                            <ProtocolBadge protocol={message.protocol} />
                            <span>{message.sender}</span>
                          </span>
                          <small>{message.preview || "暂无正文摘要"}</small>
                        </span>
                        {code ? (
                          <span className="code-pill static">{code}</span>
                        ) : null}
                      </button>
                    );
                  })
                ) : singleLoading ? (
                  <EmptyState
                    icon={LoaderCircleIcon}
                    title="正在读取邮件"
                    description="IMAP 和 Graph 可能需要几秒钟。"
                  />
                ) : (
                  <EmptyState
                    icon={FileTextIcon}
                    title="暂无邮件内容"
                    description="选择账号并点击刷新邮件。"
                  />
                )}
              </div>
              <Pager
                page={singlePage}
                totalPages={singleTotalPages}
                total={singleTotal}
                pageSize={singlePageSize}
                disabled={singleLoading}
                onChange={(page) =>
                  void handleSingleFetch(selectedAccount, page, singlePageSize)
                }
                onPageSizeChange={(size) => {
                  setSinglePageSize(size);
                  setSinglePage(1);
                  if (selectedAccount) {
                    void handleSingleFetch(selectedAccount, 1, size);
                  }
                }}
              />
            </section>
          </section>
        )}
      </div>

      <ImportDialog
        open={importOpen}
        value={importText}
        onValueChange={setImportText}
        onClose={() => setImportOpen(false)}
        onSubmit={handleImport}
      />
      <RegexDialog
        open={regexOpen}
        value={regexDraft}
        onValueChange={setRegexDraft}
        onClose={() => setRegexOpen(false)}
        onSave={handleRegexSave}
      />
      <MessageDialog
        context={dialogContext}
        verificationPattern={verificationPattern}
        onClose={() => setDialogContext(null)}
      />
    </main>
  );
}
