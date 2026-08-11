// Report types the comparison job produces. revenue_comparison.report_type is
// varchar(10), and the schema comment there also lists MTD_LY / YTD_LY /
// QTR_LY as future additions — those are not scheduled by this job yet, so
// they are deliberately absent here rather than declared and never emitted.

export const REPORT_TYPES = ['DOD', 'WOW', 'MOM', 'QOQ'] as const;
export type ReportType = typeof REPORT_TYPES[number];

/** Months back for each periodic report type. DOD/WOW are day-based, not month-based. */
export const MONTHS_BACK: Partial<Record<ReportType, number>> = {
  MOM: 1,
  QOQ: 3,
};

/** Max rows per single upsert into revenue_comparison (38 columns today). */
export const COMPARISON_INSERT_CHUNK_SIZE = 500;
