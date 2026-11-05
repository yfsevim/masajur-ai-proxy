// api/siparis.js
//
// 2026-11-05 GUVENLIK: BU ADRES ARTIK KAPALI.
//
//   Eskiden burada siparis sorgulama mantigi vardi ve bu adres internete
//   tamamen acikti - hicbir sifre istemiyordu. Adresi bilen herkes telefon
//   gondermeden siparis numaralarini tek tek deneyip musterilerin siparis
//   durumunu, odeme tipini, kargo takip numarasini ve teslim alan kisinin
//   adini cekebiliyordu.
//
//   Mantik lib/siparis.js'e tasindi. Botun kendisi (api/webhook-process.js)
//   artik o modulu DOGRUDAN cagiriyor - tipki lib/yurtici.js gibi. Arada HTTP
//   yok, yani disariya acik bir kapi da yok; ayrica bir HTTP atlamasi
//   eksildigi icin cevap daha hizli.
//
//   Bu dosya silinmek yerine burada birakildi ki: (1) eski bir cagiran
//   kalmissa 404 yerine net bir cevap alsin, (2) o cagiri log'da gorulsun.
//   Log'da uzun sure "SIPARIS ADRESI KAPALI" satiri gormuyorsak bu dosya
//   tamamen silinebilir.

module.exports = async (req, res) => {
  console.warn(
    "SIPARIS ADRESI KAPALI - istek reddedildi. method=" + (req.method || "?") +
    " user-agent=" + ((req.headers && req.headers["user-agent"]) || "?")
  );
  return res.status(410).json({
    error: "Gone",
    message: "Bu adres kullanimdan kaldirildi. Siparis sorgusu artik lib/siparis.js uzerinden yapiliyor."
  });
};
