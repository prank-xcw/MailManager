import { invoke } from "@tauri-apps/api/core";

export type MailProtocol = "imap" | "graph";
export type MailFolder = "inbox" | "spam";

export type MailAccount = {
  id: string;
  email: string;
};

export type MailMessage = {
  id: string;
  protocol: MailProtocol;
  folder: MailFolder;
  subject: string;
  sender: string;
  received_at: string;
  preview: string;
  body: string;
  body_type: "html" | "text";
};

export type MailboxResult = {
  account_id: string;
  email: string;
  protocol: MailProtocol;
  total: number;
  messages: MailMessage[];
};

export type AccountFetchResult = {
  account: MailAccount;
  total: number;
  messages: MailMessage[];
  errors: Array<{ protocol: MailProtocol; message: string }>;
  successfulProtocols: MailProtocol[];
};

export type BatchRow = {
  account: MailAccount;
  message: MailMessage | null;
  verificationCode: string;
  errors: Array<{ protocol: MailProtocol; message: string }>;
  completed: boolean;
  successfulProtocolCount: number;
  tokenInvalid: boolean;
};

export type BatchStatusFilter = "all" | "success" | "error" | "pending";

export const DEFAULT_VERIFICATION_PATTERN = String.raw`(?:验证码|校验码|动态码|安全码|确认码|verification\s*code|security\s*code|one[-\s]?time\s*(?:code|password)|otp|pin)[^\d]{0,24}(\d{4,8})|(\d{4,8})[^\d]{0,24}(?:是您的验证码|is your (?:verification )?code|用于验证|完成验证)|(?:^|[^\d])(\d{6})(?:[^\d]|$)`;

// 邮箱令牌失效特征：OAuth 刷新失败（invalid_grant / AADSTS70008x）、IMAP 认证失败、401 等
export function isTokenInvalidError(message: string): boolean {
  if (!message) return false;
  return [
    /invalid_grant/i,
    /aadsts70008/i, // refresh token 过期 / 已撤销（AADSTS700082 / 700084 等）
    /AUTHENTICATIONFAILED/i,
    /AUTHENTICATE\s+failed/i,
    /invalid\s*credentials?/i,
    /401\s*unauthorized/i,
    /token\s+(?:has\s+)?expired/i,
  ].some((pattern) => pattern.test(message));
}

export function hasTokenInvalidError(
  errors: Array<{ protocol: MailProtocol; message: string }>,
): boolean {
  return errors.some((item) => isTokenInvalidError(item.message));
}

export async function importAccounts(rawText: string): Promise<MailAccount[]> {
  return await invoke<MailAccount[]>("import_accounts", {
    request: { raw_text: rawText },
  });
}

export async function deleteAccount(accountId: string): Promise<void> {
  await invoke("delete_account", { accountId });
}

export async function listAccounts(): Promise<MailAccount[]> {
  return await invoke<MailAccount[]>("list_accounts");
}

export async function clearAllAccounts(): Promise<void> {
  await invoke("clear_all_accounts");
}

export async function exportAccounts(
  filePath: string,
  accountIds?: string[],
): Promise<string> {
  return await invoke<string>("export_accounts", { filePath, accountIds });
}

export async function fetchMailbox(
  account: MailAccount,
  folder: MailFolder,
  limit: number,
  offset = 0,
) {
  return await invoke<MailboxResult>("fetch_mailbox", {
    request: {
      account_id: account.id,
      folder,
      limit,
      offset,
    },
  });
}

export async function fetchAccount(
  account: MailAccount,
  folder: MailFolder,
  limit: number,
  offset = 0,
): Promise<AccountFetchResult> {
  try {
    const result = await fetchMailbox(account, folder, limit, offset);
    return {
      account,
      total: result.total,
      messages: result.messages,
      errors: [],
      successfulProtocols: [result.protocol],
    };
  } catch (error) {
    const message = errorMessage(error);
    return {
      account,
      total: 0,
      messages: [],
      // 后端先尝试 Graph 再回退 IMAP，整体失败时无法确定具体协议，记录两者
      errors: [
        { protocol: "graph", message },
        { protocol: "imap", message },
      ],
      successfulProtocols: [],
    };
  }
}

export async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (processed: number, total: number) => void,
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let processed = 0;
  const safeConcurrency = Math.max(
    1,
    Math.min(30, Math.floor(concurrency) || 1),
  );

  async function consume() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
      processed += 1;
      onProgress?.(processed, items.length);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(safeConcurrency, Math.max(1, items.length)) },
      () => consume(),
    ),
  );
  return results;
}

export function stripHtml(html: string) {
  const documentValue = new DOMParser().parseFromString(html, "text/html");
  return documentValue.body.textContent || "";
}

export function extractVerificationCode(
  message: MailMessage | null,
  pattern = DEFAULT_VERIFICATION_PATTERN,
) {
  if (!message) {
    return "";
  }
  const bodyText =
    message.body_type === "html" ? stripHtml(message.body) : message.body;
  const source = `${message.subject}\n${message.preview}\n${bodyText}`;
  if (!pattern.trim()) {
    return "";
  }
  try {
    // 限制输入长度防止 ReDoS：仅对前 4096 字符执行用户自定义正则
    const safeSource = source.slice(0, 4096);
    const match = safeSource.match(new RegExp(pattern, "i"));
    if (!match) return "";
    return match.slice(1).find(Boolean) || match[0];
  } catch {
    return "";
  }
}

export function sortMessages(messages: MailMessage[]) {
  return [...messages].sort((left, right) => {
    const leftTime = Date.parse(left.received_at) || 0;
    const rightTime = Date.parse(right.received_at) || 0;
    return rightTime - leftTime;
  });
}

export function formatDateTime(value: string) {
  if (!value) {
    return "未知时间";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error.trim() || "未知错误";
  }
  if (error && typeof error === "object") {
    const candidate = error as Record<string, unknown>;
    if (typeof candidate.message === "string" && candidate.message.trim()) {
      return candidate.message.trim();
    }
    if (typeof candidate.error === "string" && candidate.error.trim()) {
      return candidate.error.trim();
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "未知错误";
    }
  }
  return "未知错误";
}
