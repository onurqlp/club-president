# CLUB PRESIDENT — GitHub Pages

Futbol kulübü başkanlık simülasyonu — v1.8 (Türkçe arayüz).

## Oyun

- **Site:** https://onurqlp.github.io/club-president/
- **Kaynak dosya:** [index.html](./index.html)

## Dil desteği

Türkçe ve Almanca seçimleri 🌐 menüsünden yapılır. Oyuncu, kulüp, transfer ve kariyer verileri dil değişikliğinde korunur. Ekranlar, diyaloglar, maç olayları, transfer ekranları ve uyarılar çevrilmiştir.

## v1.4 — Kariyer geri bildirimi

- Şampiyonluk kupası, kariyer şampiyonluk sayısı ve €5M prim.
- Şampiyon ve ilk üç sezonlardan sonra yükselen rakip zorluğu.
- Teknik direktörü değiştirme; hoca seviyesi maç simülasyonunu etkiler.
- Kariyer merkezinde sezon ve maç arşivi, geçmiş maç raporları.
- Yedek alma/yükleme alanından kariyeri sıfırlama.

## v1.5 — Sezon yolculuğu

- Her maçta yeni hedef ve hedefi tamamlama ödülü.
- Derbi haftalarında özel hedef ve derbi galibiyeti primi.
- Üç/beş maçlık galibiyet serisi ve sezonun 5./10. galibiyeti için ödüller.
- Görev, derbi, galibiyet serisi ve sezon performansı kariyer kayıtlarında saklanır.

## v1.6 — Olay akışı ve teknik direktör kariyeri

- “Olaylara devam” tarihi bir sonraki yönetim kararına veya maç gününe kadar ilerletir; olaylarda oyun durur.
- Teknik direktörlerin taktik, hücum, savunma, gelişim ve insan yönetimi özellikleri maçları ve antrenman gelişimini etkiler.
- Yönetim kurulundan hocayı değiştirebilir veya görevden alabilirsin; adayların maliyetleri, maaşları ve sözleşmeleri görünür.
- Beş maçlık mağlubiyet serisi hocanın görevden alınmasına yol açar; geçici hoca ve yönetim güveni sistemi devreye girer.

## v1.7 — Mevkiye uygun maç ve oyuncu hikâyeleri

- Kaleciler şutör olamaz; goller mevkiye uygun oyuncuların bitiriciliği, kondisyonu, morali ve rakip kalecinin gücüne göre hesaplanır.
- Oyuncu notu; gol, asist, kurtarış, pas, maç kondisyonu, form ve takım sonucuna göre değişir.
- İlk 11 seçimi kondisyon, form ve morale bakar. Dinlenme kararı verilen oyuncu bir sonraki maçın dışında kalır.
- Oyuncular sezon içinde süre, dinlenme, moral veya gelecek planı için başkanla görüşme isteyebilir. Verilen süre sözleri takip edilir.

## v1.8 — Telefon arayüzü ve maç motoru

- Telefonda ana gezinme beş büyük düğmeye sadeleştirildi; Yönetim, Takvim, Telefon ve Kariyer Merkezi “Daha” menüsünde toplandı.
- Küçük ekranlarda kulüp ana ekranı, maç sahası, taktik düğmeleri ve menüler daha geniş dokunma alanları ve kaydırılabilir yerleşimle düzenlendi.
- Maçlar artık 76'ya kadar değişken uzunlukta topa sahip olma sekanslarıyla üretiliyor. Pas, çalım, top kaybı ve şutlar maç dakikasına ve sahanın konumuna bağlı.
- Mevki, pas/karar/teknik kalitesi, oyuncu kondisyonu ve formu; teknik direktör ve takım taktiği maç hesabına katılıyor. Kaleci şut çekmiyor; şut xG hesabı rakip kalecinin yeteneğine göre değişiyor.
- Mevcut kariyer kayıtları korunur; yeni motor mevcut kariyerlerin sonraki maçlarında kullanılır.

## Yayın ayarı

GitHub deposunda **Settings → Pages → Build and deployment → Deploy from a branch → main → /(root) → Save** seçeneğini etkinleştirin. Yayın etkinleşmeden site adresi 404 dönebilir.

## Kayıtlar

Oyun, kayıtları tarayıcının `localStorage` alanında tutar; Vercel ve GitHub Pages ayrı alan adları olduğundan mevcut kayıtlar otomatik taşınmaz. Kayıt varsa eski sürümde dışa aktarıp yeni sürümde içe aktarın. GitHub Pages statik barındırmadır; gerçek sunucu kimlik doğrulaması sağlamaz.
