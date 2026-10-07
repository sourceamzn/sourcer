'use strict';

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function num(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function money(value) {
  if (value === null || value === undefined) return null;
  return String(value);
}

function toClient(row) {
  if (!row) return null;
  const displayName = [row.first_name, row.last_name].filter(Boolean).join(' ');
  return {
    clientId: row.client_id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName,
    email: row.email,
    phone: row.phone,
    country: row.country,
    age: row.age,
    description: row.description,
    status: row.status,
    kycStatus: row.kyc_status,
    source: row.source,
    campaignId: row.campaign_id,
    campaign: row.campaign || null,
    agentId: row.agent_id,
    managerId: row.manager_id,
    deskId: row.desk_id,
    leadId: row.lead_id,
    convertedAt: iso(row.converted_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toLead(row) {
  if (!row) return null;
  return {
    leadId: row.lead_id,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    email: row.email,
    age: row.age,
    description: row.description,
    statusId: row.status_id,
    agentId: row.agent_id,
    managerId: row.manager_id,
    deskId: row.desk_id,
    campaignId: row.campaign_id,
    campaign: row.campaign || null,
    country: row.country || null,
    source: row.source,
    referralCode: row.referral_code || null,
    utm: row.utm || null,
    clientId: row.client_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toAffiliate(row) {
  if (!row) return null;
  return {
    affiliateId: row.affiliate_id,
    code: row.code,
    name: row.name,
    email: row.email || null,
    company: row.company || null,
    status: row.status,
    commissionType: row.commission_type,
    commissionValue: money(row.commission_value),
    notes: row.notes || null,
    leads: row.leads === undefined ? undefined : Number(row.leads),
    accounts: row.accounts === undefined ? undefined : Number(row.accounts),
    deposits: row.deposits === undefined ? undefined : Number(row.deposits),
    commission: row.commission === undefined ? undefined : money(row.commission),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toAffiliateConversion(row) {
  if (!row) return null;
  return {
    conversionId: row.conversion_id,
    affiliateId: row.affiliate_id,
    leadId: row.lead_id || null,
    clientId: row.client_id || null,
    type: row.type,
    amount: money(row.amount),
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

function toAccountType(row) {
  if (!row) return null;
  return {
    accountTypeId: row.account_type_id,
    name: row.name,
    code: row.code,
    spread: num(row.spread),
    leverage: row.leverage,
    leverageConfigurable: row.leverage_configurable,
    swapType: row.swap_type,
    swapLong: num(row.swap_long),
    swapShort: num(row.swap_short),
    marginCall: num(row.margin_call),
    stopOut: num(row.stop_out),
    commission: num(row.commission),
    status: row.status,
    description: row.description,
  };
}

function clientIdentity(row) {
  if (row.first_name === undefined && row.last_name === undefined && row.client_email === undefined) {
    return {};
  }
  return {
    clientName: [row.first_name, row.last_name].filter(Boolean).join(' ') || null,
    clientEmail: row.client_email || null,
  };
}

function toTradingAccount(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    number: row.number,
    clientId: row.client_id,
    accountTypeId: row.account_type_id,
    currency: row.currency,
    leverage: row.leverage,
    balance: money(row.balance),
    bonus: money(row.bonus),
    equity: money(row.equity),
    margin: money(row.margin),
    freeMargin: money(row.free_margin),
    status: row.status,
    archived: row.archived,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    lastActivity: iso(row.last_activity),
    ...clientIdentity(row),
  };
}

function toAccountRequest(row) {
  if (!row) return null;
  return {
    requestId: row.request_id,
    clientId: row.client_id,
    accountTypeId: row.account_type_id,
    currency: row.currency,
    status: row.status,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id,
    notes: row.notes,
    createdAt: iso(row.created_at),
    decidedAt: iso(row.decided_at),
    decidedById: row.decided_by_id,
    provisionedAccountId: row.provisioned_account_id,
    ...clientIdentity(row),
  };
}

function toOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticket: row.ticket,
    accountNumber: row.account_number,
    symbol: row.symbol,
    type: row.type,
    side: row.side,
    volume: money(row.volume),
    price: money(row.price),
    sl: money(row.sl),
    tp: money(row.tp),
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

function toPosition(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticket: row.ticket,
    accountNumber: row.account_number,
    symbol: row.symbol,
    side: row.side,
    volume: money(row.volume),
    openPrice: money(row.open_price),
    sl: money(row.sl),
    tp: money(row.tp),
    profit: money(row.profit),
    status: row.status,
    openedAt: iso(row.opened_at),
    closedAt: iso(row.closed_at),
  };
}

function toTrade(row) {
  if (!row) return null;
  return {
    id: row.id,
    ticket: row.ticket,
    accountNumber: row.account_number,
    symbol: row.symbol,
    side: row.side,
    volume: money(row.volume),
    openPrice: money(row.open_price),
    closePrice: money(row.close_price),
    profit: money(row.profit),
    openedAt: iso(row.opened_at),
    closedAt: iso(row.closed_at),
  };
}

function toTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountNumber: row.account_number,
    type: row.type,
    amount: money(row.amount),
    currency: row.currency,
    balanceAfter: money(row.balance_after),
    note: row.note,
    createdAt: iso(row.created_at),
  };
}

function toKycDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    type: row.type,
    name: row.name,
    status: row.status,
    note: row.note || null,
    uploadedAt: iso(row.uploaded_at),
    reviewedAt: iso(row.reviewed_at),
    reviewedBy: row.reviewed_by || null,
    createdAt: iso(row.created_at),
    hasContent: row.content_size != null || row.content_enc != null,
    contentSize: row.content_size == null ? null : Number(row.content_size),
  };
}

function toCashRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    accountNumber: row.account_number,
    kind: row.kind,
    amount: money(row.amount),
    currency: row.currency,
    method: row.method || null,
    reference: row.reference || null,
    comment: row.comment || null,
    beneficiary: row.beneficiary || null,
    iban: row.iban || null,
    bic: row.bic || null,
    status: row.status,
    transactionId: row.transaction_id || null,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: iso(row.reviewed_at),
    notes: row.notes || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...clientIdentity(row),
  };
}

function toSupportTicket(row) {
  if (!row) return null;
  return {
    id: row.id,
    clientId: row.client_id,
    accountNumber: row.account_number == null ? null : row.account_number,
    subject: row.subject,
    category: row.category,
    priority: row.priority,
    status: row.status,
    messages: Array.isArray(row.messages) ? row.messages : [],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...clientIdentity(row),
  };
}

function toCrmTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityType: row.entity_type || null,
    entityId: row.entity_id || null,
    title: row.title,
    due: iso(row.due),
    status: row.status,
    userId: row.user_id || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toAuditEvent(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    at: iso(row.at),
    actorType: row.actor_type,
    actorId: row.actor_id || null,
    action: row.action,
    object: row.object || null,
    details: row.details || null,
  };
}

function toDepartment(row) {
  if (!row) return null;
  return { id: row.id, key: row.key, name: row.name, active: row.active };
}

function toRole(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, desc: row.description || '', perms: row.perms || [] };
}

function toDesk(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    departmentId: row.department_id || null,
    managerId: row.manager_id || null,
    memberIds: row.member_ids || [],
    viewerIds: row.viewer_ids || [],
    active: row.active,
  };
}

function toLeadStatus(row) {
  if (!row) return null;
  return { id: row.id, label: row.label, tone: row.tone, order: row.sort_order, active: row.active };
}

function toNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    text: row.text,
    userId: row.user_id || null,
    createdAt: iso(row.created_at),
  };
}

function toUser(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    name: row.name,
    username: row.username || null,
    email: row.email,
    phone: row.phone || null,
    role: row.role,
    status: row.status,
    permissions: row.permissions || [],
    departmentId: row.department_id || null,
    deskId: row.desk_id || null,
    managerId: row.manager_id || null,
    visibleDeskIds: row.visible_desk_ids || [],
    lastLogin: iso(row.last_login),
    createdAt: iso(row.created_at),
  };
}

module.exports = {
  toClient,
  toLead,
  toAffiliate,
  toAffiliateConversion,
  toAccountType,
  toTradingAccount,
  toAccountRequest,
  toOrder,
  toPosition,
  toTrade,
  toTransaction,
  toKycDocument,
  toCashRequest,
  toSupportTicket,
  toCrmTask,
  toAuditEvent,
  toDepartment,
  toRole,
  toDesk,
  toLeadStatus,
  toNote,
  toUser,
};
