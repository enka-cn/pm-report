import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

/**
 * 中文标签从 /api/meta 取，不在前端再写一份 —— 否则同一个词在前后端各有一份，
 * 迟早会漂移（比如后端把「挂起」改成「搁置」，前端还显示旧的）。
 */
export function useMeta() {
  return useQuery({
    queryKey: ['meta'],
    queryFn: api.meta,
    staleTime: Infinity,
  });
}
