export function developmentStatusLabel(state: string): string {
  switch (state) {
    case 'queued':
      return '待機中';
    case 'running':
      return '実行中';
    case 'succeeded':
      return '完了';
    case 'failed':
      return '失敗';
    case 'cancelled':
      return 'キャンセル済み';
    default:
      return '不明';
  }
}
