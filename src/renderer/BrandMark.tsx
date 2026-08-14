import appIconUrl from "../../build/icon.png";

export function BrandMark({ small = false }: { small?: boolean }) {
  return (
    <img
      className={`brand-mark ${small ? "brand-mark--small" : ""}`}
      src={appIconUrl}
      alt=""
      aria-hidden="true"
    />
  );
}
