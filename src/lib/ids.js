'use strict';

const crypto = require('node:crypto');

const pad = (value, width) => String(value).padStart(width, '0');
const hex = () => crypto.randomUUID().replace(/-/g, '');

module.exports = {
  clientId: (n) => `C${pad(n, 6)}`,
  accountId: () => `acc_${hex()}`,
  requestId: (n) => `R-${pad(n, 4)}`,
  leadId: (n) => `L-${pad(n, 4)}`,
  userId: (n) => `U-${pad(n, 4)}`,
  orderId: () => `o_${hex()}`,
  positionId: () => `p_${hex()}`,
  tradeId: (n) => `t_${n}`,
  transactionId: (n) => `tx_${n}`,
  kycDocumentId: (n) => `KD-${pad(n, 5)}`,
  cashRequestId: (n) => `CR-${pad(n, 5)}`,
  supportTicketId: (n) => `TK-${pad(n, 5)}`,
  crmTaskId: (n) => `CT-${pad(n, 4)}`,
  affiliateId: (n) => `AF-${pad(n, 4)}`,
  conversionId: (n) => `AC-${pad(n, 4)}`,
  instrumentId: (symbol) => `ins_${String(symbol).toLowerCase().replace(/\s+/g, '')}`,
  isCanonicalClientId: (value) => /^C\d{6}$/.test(String(value || '')),
  isAccountId: (value) => /^acc_[0-9a-f]{32}$/.test(String(value || '')),
};
