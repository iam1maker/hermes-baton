export const useEffect = () => {}
export const useState = v => [typeof v === 'function' ? v() : v, () => {}]
export default {}
