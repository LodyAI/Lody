<p align="center">
    <a href="https://play.google.com/store/apps/details?id=ai.lody.android">
        <img src="https://img.shields.io/badge/Google_Play-414141?logo=google-play&logoColor=white"/>
    </a>
    <a href="https://apps.apple.com/us/app/lody-run-code-agent-anywhere/id6761373528">
        <img src="https://img.shields.io/badge/App_Store-0D96F6?logo=app-store&logoColor=white"/>
    </a>
    <a href="https://lody.ai/download">
        <img src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=F0F0F0"/>
    </a>
    <a href="https://lody.ai/download">
        <img src="https://custom-icon-badges.demolab.com/badge/Windows-0078D6?logo=windows11&logoColor=white"/>
    </a>
    <a href="https://lody.ai/download">
        <img src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black"/>
    </a>
</p>

<p align="center">
  <a href="https://lody.ai">
    <picture>
      <img src="./site-docs/public/icon-mac.png" width="128"/>
    </picture>
  </a>
</p>
<h1 align="center">
<a href="https://lody.ai" alt="lody-site">Lody</a>
</h1>
<p align="center">
  <a href="./README.md">English</a> | <a href="./README.zh-CN.md">简体中文</a> | <b>Türkçe</b>
</p>
<p align="center">
  <b>Ekibinizin zaten kullandığı kodlama ajanları için ortak bir çalışma alanı.</b>
</p>
<p align="center">
  ACP üzerinden herhangi bir makineyi bağlayın ve herhangi bir kodlama ajanını getirin. Sohbetleri ekibinizle paylaşın; masaüstü, mobil, web veya CLI'dan iş dağıtın.
</p>
<p align="center">
  <a href="https://lody.ai/docs/">
    <b>Belgeler</b>
  </a>
  |
  <a href="https://lody.ai/docs/quickstart">
    <b>Hızlı Başlangıç</b>
  </a>
</p>
<p align="center">
  <a aria-label="X" href="https://x.com/intent/follow?screen_name=lody_ai" target="_blank">
    <img alt="" src="https://img.shields.io/badge/X-%23000000.svg?style=for-the-badge&logo=X&logoColor=white">
  </a>
  <a aria-label="Discord-Link" href="https://discord.gg/E8mZtMu38s" target="_blank">
    <img alt="" src="https://img.shields.io/badge/Discord-black?style=for-the-badge&logo=discord">
  </a>
</p>

<p align="center">
  <img src="./site-docs/public/_docs-assets/lody-readme-hero.png" alt="Masaüstü ve mobilde kodlama ajanlarını çalıştıran Lody" width="100%" />
</p>

## Lody ile neler yapabilirsiniz?

### Ajan sohbetlerini ekibinizle paylaşın

Aynı sohbeti ekip arkadaşlarınızla açın. Çalışmanın etrafındaki tam dökümü, çalışma zamanı durumunu, dosyaları ve kod değişikliklerini görün; ardından ekran görüntüsü veya yapıştırılmış günlükler dolaştırmadan talimat ekleyin.

### Zaten kullandığınız Ajanları ve makineleri getirin

Claude Code, Codex, Kimi, OpenCode veya ACP uyumlu başka bir Ajanı bağlayın. Dizüstü bilgisayarlarınızda, iş istasyonlarınızda, sunucularınızda ve bulut sanal makinelerinizde yapılandırılmış abonelikleri, oturumları, modelleri ve izin kiplerini kullanmaya devam edin. Makineler, sahipleri onları çalışma alanıyla paylaşana kadar özel kalır.

### Herhangi bir yüzeyden iş dağıtın

Masaüstü, mobil, web veya CLI'dan iş dağıtırken bağlı herhangi bir makineyi seçin. İzin istekleri, ilerleme, sohbetler ve kod değişiklikleri tüm bu yüzeylerde görünür kalır.

## Bir makine bağlayın

Lody'yi bir iş istasyonunda, sunucuda veya bulut sanal makinesinde çalıştırın:

```bash
npx lody daemon start
```

Komut bir oturum açma bağlantısı açar, makineyi çalışma alanınıza bağlar ve masaüstü, mobil, web veya CLI'dan dağıtılan işler için hazır tutar.

## Lody'yi CLI'dan kullanın

CLI yalnızca bir makineyi bağlayan süreçten ibaret değildir. Bir terminalden veya betikten yerel projeleri kaydedebilir; çalışma alanlarını, makineleri, bağlı depoları ve Ajan yapılandırmalarını inceleyebilir; oturum oluşturup mesaj gönderebilir; geçmişlerini ve durumlarını okuyabilir veya arşivleyip geri yükleyebilirsiniz. `--json` destekleyen komutlar Lody çalışma alanı verilerini kendi araçlarınıza da besleyebilir.

```bash
npx lody session create --workspace my-team --agent-config codex \
  --repo owner/repo "Fix the failing test"

npx lody session list --workspace my-team
```

Tam komut referansı için [CLI belgelerine](https://lody.ai/docs/cli) bakın.

## Ajanların sohbetler arasında işi koordine etmesine izin verin

Lody, Ajanlara başka sohbetler oluşturma veya yeniden kullanma, durumlarını ve geçmişlerini okuma, takip talimatları gönderme, çalışan işi iptal etme ve sonuçları geri getirme araçları verir. Bu sayede tek bir sohbet koordinatör görevi görebilir: bir hatayı ana Ajanla analiz edip ardından inceleme, uygulama ve testi paralel çalışan ayrı sohbetlere devredebilirsiniz.

Lody her alt sohbeti bağımsız tutarken onu oluşturan sohbetle ilişkisini korur. Siz veya bir Ajan oturumlar arasında işi bağlamak istediğinde sohbetlere `@` bahsetmesiyle de referans verilebilir.

## Kodu ve yürütmeyi aynı çalışma alanında tutun

### Paralel çalışmayı yalıtılmış tutun

Ajanların değişiklikleri karıştırmadan paralel çalışabilmesi için oturumlara kendi Git worktree'lerini verin. Sekmelerde birden fazla sohbet, dosya, fark (diff), terminal ve önizleme açın veya farklı bir yaklaşımı denemek için bir oturumu başka bir sohbete ya da worktree'ye çatallayın.

### Değişiklikleri işin yapıldığı yerde inceleyin

Proje dosyalarına göz atın ve sohbetin yanında tur bazlı veya tam oturum farklarını inceleyin. Satır düzeyinde yorum ekleyin, pull request durumunu ve CI'ı izleyin ve GitHub inceleme dizilerini değişikliği üreten Ajana yakın tutun.

<p align="center">
  <img src="./site-docs/public/_docs-assets/PR-panel.png" alt="Bir Ajan sohbetinin yanında pull request ve CI durumu" width="100%" />
</p>

### Ajanlara görsel geri bildirim verin

Çalışan bir web uygulamasını oturum içinde açın, duyarlı görünüm boyutları arasında geçiş yapın ve öğe düzeyinde görsel işaretlemeleri doğrudan Ajana geri gönderin.

<p align="center">
  <img src="./site-docs/public/_docs-assets/20260507-preview.png" alt="Çalışan bir web uygulamasını işaretleme ve geri bildirimi Ajana gönderme" width="100%" />
</p>

## Dahili diğer özellikler

- **Ajan Rolleri** — yeniden kullanılabilir Ajan, model, izin ve talimat ön ayarlarını ekiple paylaşın.
- **Ekler** — masaüstü, mobil, web veya CLI'dan dosya ve görseller gönderin, Ajanların ürettiği dosyaları alın.
- **Oturum araçları** — geçmişlerini kaybetmeden sohbetleri arayın, sabitleyin, arşivleyin, çatallayın ve düzenleyin.
- **Masaüstü araçları** — dahili terminal, komut paleti, özelleştirilebilir kısayollar kullanın ve dosyaları düzenleyicinizde açın.
- **Mobil kontroller** — bildirimler alın, izin isteklerini onaylayın, farkları inceleyin ve iOS Canlı Etkinlikleri (Live Activities) ile aktif işi izleyin.
- **Kullanım görünürlüğü** — bağlam, token ve kota kullanımının yanı sıra makine ve Ajan kaynak tüketimini görün.

<p align="center">
  <img src="./site-docs/public/_docs-assets/20260611-island.png" alt="Bir iPhone Canlı Etkinliğinden Ajan izin isteğini onaylama" width="60%" />
</p>

## Sohbetlerin ötesinde

Paylaşılan sohbetler Lody'nin başlangıç noktasıdır, çalışma alanının tamamı değil.

Ekiplerin gereksinimleri şekillendirebilmesi, kararları koruyabilmesi ve tek bir sohbetin zaman çizelgesi dışında Ajanlarla çalışabilmesi için belgeler ve belge korumalı alanları (document sandboxes) eklemeyi planlıyoruz. Zamanla bu araçlar yalnızca neyin değiştiğini değil, neden değiştiğini de anlamak için paylaşılan ekip bağlamına dönüşebilir.

Yalnızca sohbetlerin değil, tüm çalışma alanının yerel öncelikli (local-first) olmasını istiyoruz. Lody, iş birlikçi durumu CRDT'lerle temsil etmek ve eşitlemek için Loro ve Flock dahil [Loro](https://loro.dev/) Yığınını kullanır. Aynı temel sohbetlerden belgelere ve gelecekteki çalışma alanı araçlarına uzanabilir. Hedefimiz ekip bağlamının daha dayanıklı, taşınabilir ve nihayetinde ekibin kontrolünde kalmasıdır.

Lody hâlâ tam yerel öncelikli desteğe doğru ilerlemektedir.

## Sürümler

Kararlı bir `vX.Y.Z` etiketi göndermek, varsayılan daldaki her `apps/*/package.json` sürümünü eşitleyen bir taslak PR oluşturur ve ardından otomatik üretilen değişiklik notlarıyla bir GitHub Release yayımlar. Yükleyici veya otomatik güncelleme dosyaları derlenmez veya yüklenmez. Orijinal etiket taşınmaz; sürüm eşitlemesi PR birleştirildikten sonra varsayılan dalda geçerli olur. Depo ayarlarında GitHub Actions'ın pull request oluşturmasına izin verilmelidir. Bot tarafından oluşturulan PR'lar CI'ı tetiklemek için bir bakımcı işlemi gerektirebilir. Mevcut sürümler ve varlıkları yeniden çalıştırmalarda korunur.

## Depo yapısı

- `apps/cli` — Makineleri bağlayın ve kodlama ajanlarını çalıştırın
- `apps/electron` — Lody masaüstü uygulaması
- [`apps/mobile`](apps/mobile/README.md) — Yeni yerel iOS ve Android istemcileri
- [`apps/mobile-capacitor`](apps/mobile-capacitor/README.md) — iOS ve Android için Capacitor bulut istemcisi
- `packages/client-e2ee` — Paylaşılan tarayıcı/mobil bulut E2EE bileşimi
- `packages/components` — Paylaşılan çalışma alanı arayüzü
- `packages/ui` — Temel arayüz yapı taşları ve StyleX tasarım belirteçleri
- `packages/platform` — Platform yetenekleri ve entegrasyonları
- `packages/shared` — Paylaşılan şemalar, protokoller ve yardımcılar
- `packages/cloud-api` — İsteğe bağlı bulut protokol adları ve DTO'ları
- `packages/e2ee-core` — Uçtan uca şifreleme kütüphanesi: imzalı defter, anahtar teslimi, servisler ve bağdaştırıcılar ([okuma kılavuzu](packages/e2ee-core/README.md)). Ürün ana bilgisayarları: [çalışma alanı önyüklemesi](.agents/docs/e2ee-workspace-bootstrap.md)
- `packages/e2ee-client` — Kişisel cihaz E2EE ana bilgisayarı
- `packages/e2ee-machine-sharing` — Makine servisi paylaşım politikası
- `packages/e2ee-lab` — `@lody/e2ee-core` için yerel saldırı test tüketicileri ve kalıcılık yoklayıcıları
- `packages/turn-diff-store` — Yerel içerik adresli tur anlık görüntüleri
- `packages/loro-streams-rpc` — Loro Streams üzerinden RPC
- `packages/iroh-native` — Şifreli çalışma alanı RPC'si için yerel iroh aktarımı ([kurallar](packages/iroh-native/AGENTS.md))
- `packages/acp-extension-{core,kimi,pi}` — ACP uzantı alt modül çalışma alanları. Kimi ve Pi kök pnpm grafiğinin dışında kalır
- `site-docs` — Web sitesi, belgeler ve blog
- [`skills`](skills/README.md) — `lody` ve `lody-cli` dahil resmî Ajan becerileri alt modülü (`LodyAI/skills`)

Geliştirme kurulumu ve topluluk PR boyut politikası için [CONTRIBUTING.md](./CONTRIBUTING.md) dosyasına bakın.

## Mobil ve yukarı akış atıfları

Lody'nin yeni yerel mobil istemcileri [apps/mobile](apps/mobile/README.md) dizinindedir. Aktif geliştirme altındadırlar ve bağımsız iOS ile Android derleme araç zincirlerini korurlar; kurulum ve mevcut kapsam için mobil README dosyasına bakın.

iOS istemcisi doğrudan **[Innei'nin lody-ios](https://github.com/Innei/lody-ios)** projesi üzerine kurulmuştur. Bu çalışmayı mümkün kılan yerel uygulama, sohbet deneyimi, uygulama mimarisi ve Loro/Flock protokol çalışma zamanı için [Innei](https://github.com/Innei)'ye ve yukarı akış katkıda bulunanlara teşekkür ederiz. Android de bu çalışma zamanının kaynak izli bir anlık görüntüsünü yeniden kullanır. Yukarı akış lisansları, bildirimler ve ek teşekkürler [mobil atıfları](apps/mobile/README.md#credits-and-origins) içinde korunmuştur.
