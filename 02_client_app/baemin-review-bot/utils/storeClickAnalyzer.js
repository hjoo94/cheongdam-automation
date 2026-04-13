function parseNumber(value = '') {
  const text = String(value || '').replace(/,/g, '');
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function formatNumber(value) {
  return Math.round(Number(value || 0)).toLocaleString('ko-KR');
}

function formatWon(value) {
  return `${formatNumber(value)}원`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return '0%';
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function looksLikeDate(value = '') {
  return /^(\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[-./]\d{1,2})/.test(String(value || '').trim());
}

function looksLikeTimeSlot(value = '') {
  const text = String(value || '').trim();
  return (
    /^(\d{1,2})(?::\d{2})?\s*[~-]\s*(\d{1,2})(?::\d{2})?/.test(text) ||
    /^\d{1,2}\s*시/.test(text) ||
    /오전|오후|점심|저녁|심야|새벽|피크|시간대/.test(text)
  );
}

function isHeaderLine(line = '') {
  const text = String(line || '');
  return /날짜|시간대|광고지출|광고비|노출|클릭|주문|주문금액|광고효과|ROAS/i.test(text) &&
    !/\d/.test(text.replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, ''));
}

function splitRow(line = '') {
  return String(line || '')
    .split(/\t| {2,}|,/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseStoreClickRows(text = '') {
  const lines = String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const rows = [];
  for (const line of lines) {
    if (isHeaderLine(line)) continue;

    const parts = splitRow(line);
    if (parts.length < 5) continue;

    let cursor = 0;
    let date = '';
    let timeSlot = '';

    if (looksLikeDate(parts[cursor])) {
      date = parts[cursor];
      cursor += 1;
    }

    if (looksLikeTimeSlot(parts[cursor])) {
      timeSlot = parts[cursor];
      cursor += 1;
    } else if (!date) {
      date = parts[cursor];
      cursor += 1;
    }

    const metricParts = parts.slice(cursor);
    if (metricParts.length < 4) continue;

    const adSpend = parseNumber(metricParts[0]);
    const impressions = parseNumber(metricParts[1]);
    const clicks = parseNumber(metricParts[2]);
    const orders = parseNumber(metricParts[3]);
    const orderAmount = parseNumber(metricParts[4] || '');
    const roasText = metricParts[5] || '';

    rows.push({
      date,
      timeSlot,
      adSpend,
      impressions,
      clicks,
      orders,
      orderAmount,
      roas: parseNumber(roasText),
    });
  }

  return rows;
}

function buildMetrics(totals = {}) {
  const ctr = totals.impressions ? (totals.clicks / totals.impressions) * 100 : 0;
  const cvr = totals.clicks ? (totals.orders / totals.clicks) * 100 : 0;
  const cpc = totals.clicks ? totals.adSpend / totals.clicks : 0;
  const cpa = totals.orders ? totals.adSpend / totals.orders : 0;
  const roas = totals.adSpend ? totals.orderAmount / totals.adSpend : 0;
  return { ctr, cvr, cpc, cpa, roas };
}

function addTotals(acc, row) {
  acc.adSpend += row.adSpend || 0;
  acc.impressions += row.impressions || 0;
  acc.clicks += row.clicks || 0;
  acc.orders += row.orders || 0;
  acc.orderAmount += row.orderAmount || 0;
  return acc;
}

function summarizeTimeSlots(rows = []) {
  const bySlot = new Map();

  for (const row of rows) {
    if (!row.timeSlot) continue;
    if (!bySlot.has(row.timeSlot)) {
      bySlot.set(row.timeSlot, {
        timeSlot: row.timeSlot,
        adSpend: 0,
        impressions: 0,
        clicks: 0,
        orders: 0,
        orderAmount: 0,
      });
    }
    addTotals(bySlot.get(row.timeSlot), row);
  }

  return Array.from(bySlot.values())
    .map((item) => {
      const metrics = buildMetrics(item);
      let action = '유지';
      let reason = `광고효과 ${metrics.roas.toFixed(2)}배, 주문당 광고비 ${formatWon(metrics.cpa)}입니다.`;

      if (metrics.roas >= 6 && item.orders >= 1) {
        action = '증액';
        reason = `성과가 좋아 클릭당 희망 광고금액을 소폭 올려도 됩니다. ${reason}`;
      } else if (metrics.roas > 0 && metrics.roas < 3) {
        action = '감액';
        reason = `광고비 대비 주문금액이 낮아 클릭당 희망 광고금액을 낮추는 편이 낫습니다. ${reason}`;
      } else if (item.clicks >= 5 && item.orders === 0) {
        action = 'OFF';
        reason = `클릭은 발생했지만 주문이 없어 해당 시간대 광고를 끄거나 최저 단가로 낮추세요. ${reason}`;
      }

      return {
        ...item,
        metrics,
        action,
        reason,
      };
    })
    .sort((a, b) => {
      const order = { '증액': 0, '유지': 1, '감액': 2, 'OFF': 3 };
      return (order[a.action] ?? 9) - (order[b.action] ?? 9) || b.orderAmount - a.orderAmount;
    });
}

function analyzeStoreClickText(text = '') {
  const rows = parseStoreClickRows(text);
  const totals = rows.reduce(addTotals, { adSpend: 0, impressions: 0, clicks: 0, orders: 0, orderAmount: 0 });
  const metrics = buildMetrics(totals);
  const timeSlots = summarizeTimeSlots(rows);

  const recommendations = [];
  if (!rows.length) {
    recommendations.push('성과 표를 복사해서 붙여넣으면 분석할 수 있습니다.');
  } else {
    if (metrics.ctr < 3) recommendations.push('노출 대비 클릭률이 낮습니다. 노출 위치, 대표 메뉴명, 사진을 먼저 점검하세요.');
    if (metrics.cvr < 10) recommendations.push('클릭 후 주문전환율이 낮습니다. 메뉴 구성, 최소주문금액, 배달비, 리뷰 상태를 같이 확인하세요.');
    if (metrics.roas >= 6) recommendations.push('광고효과가 양호합니다. 주문 피크 시간대는 클릭당 희망 광고금액을 유지하거나 소폭 증액할 수 있습니다.');
    if (metrics.roas > 0 && metrics.roas < 3) recommendations.push('광고비 대비 주문금액이 낮습니다. 저성과 시간대는 광고 노출을 줄이거나 클릭 단가를 낮추세요.');
    if (timeSlots.length) {
      const slotText = timeSlots
        .slice(0, 6)
        .map((item) => `${item.timeSlot}: ${item.action} (${item.reason})`)
        .join('\n');
      recommendations.push(`시간대별 클릭당 희망 광고금액 조정안:\n${slotText}`);
    }
    if (!recommendations.length) recommendations.push('성과가 중간 구간입니다. 피크 시간과 비피크 시간을 나눠 단가를 다르게 운영하세요.');
  }

  return {
    rows,
    totals,
    metrics,
    timeSlots,
    summary: [
      `총 노출 ${formatNumber(totals.impressions)}회, 클릭 ${formatNumber(totals.clicks)}회, 주문 ${formatNumber(totals.orders)}건입니다.`,
      `광고비 ${formatWon(totals.adSpend)}로 주문금액 ${formatWon(totals.orderAmount)}가 발생했고 광고효과는 ${metrics.roas.toFixed(2)}배입니다.`,
      `CTR ${formatPercent(metrics.ctr)}, CVR ${formatPercent(metrics.cvr)}, 평균 CPC ${formatWon(metrics.cpc)}, 주문당 광고비 ${formatWon(metrics.cpa)}입니다.`,
    ],
    recommendations,
  };
}

module.exports = {
  analyzeStoreClickText,
  parseStoreClickRows,
};
