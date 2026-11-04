# CLUB PRESIDENT — GitHub Pages

Futbol kulübü başkanlık simülasyonu — v1.17 (Türkçe arayüz).

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

## v1.9 — Scout ve genç yetenek sistemi

- İki gözlemciye genç yetenek, kadro açığı veya belirli mevki için görev verilebilir.
- Haftalık scout bütçesi kullanıcı tarafından belirlenir; her 7 oyun gününde kasadan düşer. Yeterli bütçe yoksa gözlem durur.
- Beş oyun gününde bir scout seviyesine göre 2–3 genç aday raporlar; tahmini potansiyel, yaş, mevki ve oyun içi değer görünür.
- Adaylar kısa listeye eklenebilir ve transfer görüşmesine doğrudan taşınabilir. Öneri kartı kadroda eksik veya zayıf mevkiyi öne çıkarır.
- Genç oyuncular oyun içinde üretilmiş kurgusal adaylardır; var olan kariyer kayıtlarına ek alanlar eklenir, kayıt sıfırlanmaz.

## v1.10 — Menü geçişi ve telefon pencereleri

- Bir menüye geçildiğinde açık olan önceki modal/pencere kapanır; içerik yeni ekranla birlikte temizlenir.
- Pencere dışına dokunma ve Escape ile kapatma eklendi; modal erişilebilirlik etiketleri tamamlandı.
- Telefonda modallar alt sayfa paneli olarak açılır; düğmeler ve kapatma alanı büyütüldü, uzun listeler kaydırılabilir.

## v1.11 — Kayıt, fikstür ve maç sürekliliği

- Eski kariyer kayıtları sürüm alanlarıyla taşınır; ilk güncellemede otomatik yedek oluşturulur ve v3 kayıtları açılışta reddedilmez.
- Resmî fikstür mevcutsa alternatif takvim tarafından ezilmez; oluşturulan fikstür açıkça oyun üretimi olarak etiketlenir.
- Maç ekranı gerçek iç saha/deplasman sırasını gösterir; maç sırasında dakika, skor, top konumu, olaylar ve taktik geçmişi kaydedilerek yenileme sonrası sürdürülebilir.
- Taktik değişikliği kalan maçı mevcut dakika ve top konumundan devam ettirir; rakip planı ve takım planı maçın tamamına tek etiket olarak yazılmaz.
- Kaleciler saha oyuncusu eylem havuzundan çıkarıldı; rakip kalecinin kalitesi şutun xG’sini, isabetini ve olay kaydını etkiler.
- Transfer oyuncu kaydı yeni kulübe taşınır; satışta asgari kadro ve mevki derinliği denetlenir.

## v1.15 — Kadro bağlantılı 3D maç aksiyonları

- Maç olayları pası atan ve pası alan gerçek ilk 11 slotlarını taşır; 3D sahne aksiyonları bu oyuncularla eşleştirir.
- 3D oyuncular kaleci, savunma, orta saha ve hücum mevkilerine göre yerleşir; pasör, alıcı, baskı yapan savunmacı ve kaleci pozisyona göre hareket eder.
- Pas isabeti, alıcı oyuncunun karar kalitesinden de etkilenir. Simülasyon, istatistikler ve maç olayları aynı olay akışını kullanır.

## v1.16 — Maç ekranı açılışı

- Türkçe/Almanca çeviri yardımcısı maç ekranının kullandığı ana kapsamda tanımlandı; Maça Çık ekranı artık açılışta hata vermiyor.

## v1.17 — Maç dışı kararların devamlılığı

- Sponsor, altyapı ve basın kararları yanıtlanmadan gün ilerletilemez veya maç ekranına geçilemez.
- Açık karar kayıt yenilense bile kariyerde korunur ve devam edildiğinde yeniden gösterilir.
- Telefon gelen kutusunda açık karara dönmek için belirgin bir bağlantı bulunur.
- Bu güncelleme maç simülasyonuna, 3D maç motoruna veya maç günü varlıklarına dokunmaz.

## v1.17 — Fortsetzung von Entscheidungen außerhalb des Spiels

- Sponsoring-, Akademie- und Presseentscheidungen können nicht übersprungen werden, bevor der Tag oder das Spiel fortgesetzt wird.
- Eine offene Entscheidung bleibt nach dem Neuladen gespeichert und erscheint beim Fortsetzen der Karriere erneut.
- Im Posteingang gibt es einen direkten Link zurück zur offenen Entscheidung.
- Diese Änderung greift nicht in die Spielsimulation, den 3D-Spielmotor oder die Spieltagsdateien ein.

## Yayın ayarı

GitHub deposunda **Settings → Pages → Build and deployment → Deploy from a branch → main → /(root) → Save** seçeneğini etkinleştirin. Yayın etkinleşmeden site adresi 404 dönebilir.

## Kayıtlar

Oyun, kayıtları tarayıcının `localStorage` alanında tutar; Vercel ve GitHub Pages ayrı alan adları olduğundan mevcut kayıtlar otomatik taşınmaz. Kayıt varsa eski sürümde dışa aktarıp yeni sürümde içe aktarın. GitHub Pages statik barındırmadır; gerçek sunucu kimlik doğrulaması sağlamaz.
