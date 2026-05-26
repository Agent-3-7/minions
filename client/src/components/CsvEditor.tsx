import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  type ColDef,
  type CellValueChangedEvent,
  type GridReadyEvent,
  colorSchemeDark,
  colorSchemeLight,
  themeQuartz,
} from 'ag-grid-community';
import Papa from 'papaparse';
import { useIsDarkMode } from '../hooks/useTheme';

const SHARED_THEME_PARAMS = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  cellHorizontalPadding: 12,
  spacing: 4,
};

const lightTheme = themeQuartz.withPart(colorSchemeLight).withParams({
  ...SHARED_THEME_PARAMS,
  backgroundColor: '#ffffff',
  headerBackgroundColor: '#fafafa',
  borderColor: '#e4e4e7',
  rowBorder: { color: '#f4f4f5' },
});

const darkTheme = themeQuartz.withPart(colorSchemeDark).withParams({
  ...SHARED_THEME_PARAMS,
  backgroundColor: '#09090b',
  headerBackgroundColor: '#18181b',
  borderColor: '#27272a',
  rowBorder: { color: '#18181b' },
});

const AG_MODULES = [AllCommunityModule];
const DEFAULT_COL_DEF: ColDef = { flex: 1, minWidth: 100, resizable: true };
const ROW_NUM_CELL_STYLE = { color: '#a1a1aa', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const };

type ParsedCsv = {
  headers: string[];
  rows: Record<string, string>[];
};

function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.trim(), {
    skipEmptyLines: true,
  });

  const raw = result.data;
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = raw[0];
  const rows = raw.slice(1).map((row) => {
    const record: Record<string, string> = {};
    headers.forEach((h, i) => {
      record[h] = row[i] ?? '';
    });
    return record;
  });

  return { headers, rows };
}

function serializeCsv(headers: string[], rows: Record<string, string>[]): string {
  const data = rows.map((row) => headers.map((h) => row[h] ?? ''));
  return Papa.unparse({ fields: headers, data });
}

export function CsvEditor({
  content,
  onContentChange,
}: {
  content: string;
  onContentChange: (content: string) => void;
}) {
  const isDark = useIsDarkMode();
  const headersRef = useRef<string[]>([]);
  const lastSerializedRef = useRef<string | null>(null);

  const parsed = useMemo(() => {
    if (content === lastSerializedRef.current) return null;
    return parseCsv(content);
  }, [content]);

  const [rowData, setRowData] = useState<Record<string, string>[]>(() => parseCsv(content).rows);

  useEffect(() => {
    if (!parsed) return;
    setRowData(parsed.rows);
    headersRef.current = parsed.headers;
  }, [parsed]);

  const headers = parsed?.headers ?? headersRef.current;

  const columnDefs = useMemo<ColDef[]>(() => {
    if (headers.length === 0) return [];

    const rowNumCol: ColDef = {
      headerName: '#',
      valueGetter: (params) => params.node ? params.node.rowIndex! + 1 : '',
      width: 56,
      pinned: 'left',
      editable: false,
      sortable: false,
      filter: false,
      suppressMovable: true,
      cellStyle: ROW_NUM_CELL_STYLE,
    };

    const dataCols: ColDef[] = headers.map((header) => ({
      field: header,
      headerName: header,
      editable: true,
      sortable: true,
      filter: true,
      resizable: true,
      minWidth: 80,
    }));

    return [rowNumCol, ...dataCols];
  }, [headers]);

  const onCellValueChanged = useCallback(
    (event: CellValueChangedEvent) => {
      const allRows: Record<string, string>[] = [];
      event.api.forEachNode((node) => {
        if (node.data) allRows.push(node.data);
      });
      const csv = serializeCsv(headersRef.current, allRows);
      lastSerializedRef.current = csv;
      onContentChange(csv);
    },
    [onContentChange],
  );

  const onGridReady = useCallback((event: GridReadyEvent) => {
    event.api.sizeColumnsToFit();
  }, []);

  if (headers.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-zinc-400 dark:text-zinc-500">
        Empty or invalid CSV
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0">
      <AgGridReact
        modules={AG_MODULES}
        theme={isDark ? darkTheme : lightTheme}
        rowData={rowData}
        columnDefs={columnDefs}
        onCellValueChanged={onCellValueChanged}
        onGridReady={onGridReady}
        defaultColDef={DEFAULT_COL_DEF}
        animateRows={false}
        suppressColumnVirtualisation={headers.length <= 50}
        rowSelection="multiple"
        enableCellTextSelection
      />
    </div>
  );
}
