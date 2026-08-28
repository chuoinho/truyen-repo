package eu.kanade.tachiyomi.extension.vi.hamtruyen

import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.interceptor.rateLimit
import eu.kanade.tachiyomi.source.model.Filter
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.online.HttpSource
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.util.concurrent.ConcurrentHashMap

class HamTruyen : HttpSource() {

    override val name = "HamTruyen"

    override val lang = "vi"

    override val baseUrl = "https://hamtruyen.top"

    override val supportsLatest = true

    private val imageCdnCache = ConcurrentHashMap<String, String>()
    private val imagePathCache = ConcurrentHashMap<String, Boolean>()

    override val client: OkHttpClient = network.cloudflareClient.newBuilder()
        .addInterceptor(::interceptImageProxy)
        .rateLimit(3)
        .build()

    override fun headersBuilder(): Headers.Builder = super.headersBuilder()
        .add("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .add("Accept-Language", "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7")
        .add("Referer", "$baseUrl/")

    override fun popularMangaRequest(page: Int): Request = GET("$baseUrl/top/views", headers)

    override fun popularMangaParse(response: Response): MangasPage = listingParse(response, hasNextPage = false)

    override fun latestUpdatesRequest(page: Int): Request {
        val url = if (page <= 1) "$baseUrl/top/new" else "$baseUrl/page/$page"
        return GET(url, headers)
    }

    override fun latestUpdatesParse(response: Response): MangasPage {
        val document = response.asJsoup()
        val currentPage = response.request.url.pathSegments.lastOrNull()?.toIntOrNull() ?: 1
        return listingParse(document, hasNextPage = currentPage == 1 || document.hasNextLatestPage(currentPage))
    }

    private fun listingParse(response: Response, hasNextPage: Boolean): MangasPage = listingParse(response.asJsoup(), hasNextPage)

    private fun listingParse(document: Document, hasNextPage: Boolean): MangasPage {
        val mangas = document.select("a[href]:has(img[src*=/api/image/proxy])")
            .filterNot { it.hasExplicitZeroChapters() }
            .mapNotNull { it.toSManga() }
            .distinctBy { it.url }

        return MangasPage(mangas, hasNextPage)
    }

    private fun Element.toSManga(): SManga? {
        val href = absUrl("href").takeIf { it.isNotBlank() } ?: return null
        val path = href.toStoryPath() ?: return null
        val image = selectFirst("img") ?: return null
        val titleText = selectFirst("h3")?.text()
            ?.ifBlank { image.attr("alt") }
            ?.takeIf { it.isNotBlank() }
            ?: return null

        return SManga.create().apply {
            url = path
            title = titleText
            thumbnail_url = image.imageUrl()
        }
    }

    override fun searchMangaRequest(page: Int, query: String, filters: FilterList): Request {
        if (query.isNotBlank()) {
            val url = "$baseUrl/search".toHttpUrl().newBuilder()
                .addQueryParameter("q", query)
                .addQueryParameter("page", page.toString())
                .build()
            return GET(url, headers)
        }

        val sort = filters.filterIsInstance<SortFilter>().firstOrNull()?.selected ?: SortFilter.DEFAULT
        return GET("$baseUrl/${sort.path}", headers)
    }

    override fun searchMangaParse(response: Response): MangasPage = listingParse(response, hasNextPage = false)

    override fun getFilterList(): FilterList = FilterList(
        Filter.Header("Bo loc chi dung khi khong tim theo ten"),
        SortFilter(),
    )

    override fun mangaDetailsRequest(manga: SManga): Request = GET(baseUrl + manga.url, headers)

    override fun getMangaUrl(manga: SManga): String = baseUrl + manga.url

    override fun mangaDetailsParse(response: Response): SManga {
        val document = response.asJsoup()
        val detailsSection = document.selectFirst("main section")
        return SManga.create().apply {
            title = document.selectFirst("main h1")?.text()
                ?.ifBlank { document.title().substringBefore("—").trim() }
                .orEmpty()
            thumbnail_url = detailsSection?.selectFirst("img[src*=/api/image/proxy]")?.imageUrl()
                ?: document.selectFirst("meta[property=og:image]")?.attr("content")
            genre = detailsSection?.select(".flex.flex-wrap.gap-2 span")
                ?.map { it.text().trim() }
                ?.filter { it.isNotBlank() }
                ?.distinct()
                ?.joinToString()
            description = document.selectFirst("#story-desc")?.wholeText()?.trim()
            status = when {
                description?.contains("hoan thanh", ignoreCase = true) == true -> SManga.COMPLETED
                description?.contains("dang duoc cap nhat", ignoreCase = true) == true -> SManga.ONGOING
                else -> SManga.UNKNOWN
            }
        }
    }

    override fun chapterListRequest(manga: SManga): Request = mangaDetailsRequest(manga)

    override fun chapterListParse(response: Response): List<SChapter> {
        val document = response.asJsoup()
        return document.select("#chapterList a[href], main a[href*=/chuong-]")
            .distinctBy { it.absUrl("href") }
            .mapNotNull { element ->
                val href = element.absUrl("href").takeIf { it.isNotBlank() } ?: return@mapNotNull null
                val path = href.toChapterPath() ?: return@mapNotNull null
                val chapterName = element.text().trim().ifBlank { path.substringAfterLast("/") }

                SChapter.create().apply {
                    url = path
                    name = chapterName
                    chapter_number = CHAPTER_NUMBER_REGEX.find(chapterName)
                        ?.groupValues
                        ?.getOrNull(1)
                        ?.toFloatOrNull()
                        ?: -1f
                }
            }
    }

    override fun getChapterUrl(chapter: SChapter): String = baseUrl + chapter.url

    override fun pageListRequest(chapter: SChapter): Request = GET(getChapterUrl(chapter), headers)

    override fun pageListParse(response: Response): List<Page> {
        val document = response.asJsoup()
        val chapterUrl = response.request.url.toString()
        val images = document.select(".chapter-reader img[src], main img[src*=/api/image/proxy]")
            .mapNotNull { it.imageUrl() }
            .filterNot { it.contains("placeholder", ignoreCase = true) }
            .distinctBy { imageUrl ->
                imageUrl.toHttpUrlOrNull()?.queryParameter("url") ?: imageUrl.substringBefore("?")
            }

        val verifiedImages = verifyAndTrimImages(images, chapterUrl)
        if (verifiedImages != null) {
            return verifiedImages.mapIndexed { index, imageUrl -> Page(index, chapterUrl, imageUrl) }
        }

        throw Exception("HamTruyen da mat anh chapter tren toan bo CDN cua chinh nguon")
    }

    private fun verifyAndTrimImages(images: List<String>, referer: String): List<String>? {
        if (images.isEmpty()) return null
        val verified = images.toMutableList()

        if (!isImageAvailable(verified.first(), referer)) {
            if (verified.size <= 1 || !isImageAvailable(verified[1], referer)) return null
            verified.removeAt(0)
        }
        if (!isImageAvailable(verified.last(), referer)) {
            if (verified.size <= 1 || !isImageAvailable(verified[verified.lastIndex - 1], referer)) return null
            verified.removeAt(verified.lastIndex)
        }
        if (!isImageAvailable(verified[verified.size / 2], referer)) return null
        return verified
    }

    private fun isImageAvailable(url: String, referer: String): Boolean = runCatching {
        val imageHeaders = headers.newBuilder()
            .set("Referer", referer)
            .set("Accept", "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
            .build()
        client.newCall(GET(url, imageHeaders)).execute().use { response ->
            response.isSuccessful && response.header("Content-Type").orEmpty().startsWith("image/")
        }
    }.getOrDefault(false)

    override fun imageRequest(page: Page): Request {
        val referer = page.url.takeIf { it.isNotBlank() } ?: "$baseUrl/"
        val imageHeaders = headers.newBuilder()
            .set("Referer", referer)
            .set("Accept", "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8")
            .build()
        return GET(page.imageUrl!!, imageHeaders)
    }

    override fun imageUrlParse(response: Response): String = throw UnsupportedOperationException()

    private fun interceptImageProxy(chain: Interceptor.Chain): Response {
        val originalRequest = chain.request()
        val proxyUrl = originalRequest.url
        val directUrl = proxyUrl.queryParameter("url")?.toHttpUrlOrNull()

        if (
            proxyUrl.host != IMAGE_PROXY_HOST ||
            !proxyUrl.encodedPath.contains(IMAGE_PROXY_PATH) ||
            directUrl == null ||
            directUrl.host !in IMAGE_CDN_HOSTS
        ) {
            return chain.proceed(originalRequest)
        }

        val cacheKey = directUrl.encodedPath.substringBeforeLast("/")
        val originalPath = directUrl.encodedPath
        val legacyFixedPath = originalPath.replaceFirst(LEGACY_PATH_PREFIX, "/")
        val cachedHost = imageCdnCache[cacheKey]
        val cachedPath = if (imagePathCache[cacheKey] == true) legacyFixedPath else originalPath
        val hosts = listOfNotNull(cachedHost, directUrl.host) + IMAGE_CDN_HOSTS
        val paths = listOf(cachedPath, originalPath, legacyFixedPath).distinct()
        val candidates = buildList {
            paths.forEach { path ->
                hosts.distinct().forEach { host ->
                    add(directUrl.newBuilder().host(host).encodedPath(path).build())
                }
            }
        }.distinctBy { it.toString() }

        var response: Response? = null
        candidates.forEach { candidate ->
            response?.close()
            response = chain.proceed(originalRequest.withProxyTarget(candidate))
            if (response.isSuccessful) {
                imageCdnCache[cacheKey] = candidate.host
                imagePathCache[cacheKey] = candidate.encodedPath == legacyFixedPath && legacyFixedPath != originalPath
                return response
            }
        }

        return response ?: chain.proceed(originalRequest)
    }

    private fun Request.withProxyTarget(targetUrl: okhttp3.HttpUrl): Request = newBuilder()
        .url(url.newBuilder().setQueryParameter("url", targetUrl.toString()).build())
        .build()

    private fun Document.hasNextLatestPage(currentPage: Int): Boolean = selectFirst("a[href='/page/${currentPage + 1}']") != null

    private fun Element.imageUrl(): String? = attr("abs:data-src")
        .ifBlank { attr("abs:src") }
        .takeIf { it.isNotBlank() }

    private fun Element.hasExplicitZeroChapters(): Boolean {
        val chapterText = select("span")
            .map { it.text().trim() }
            .firstOrNull { CHAPTER_COUNT_REGEX.containsMatchIn(it) }
            ?: return false

        val count = CHAPTER_COUNT_REGEX.find(chapterText)
            ?.groupValues
            ?.getOrNull(1)
            ?.toIntOrNull()
            ?: return false

        return count == 0
    }

    private fun String.toStoryPath(): String? {
        val url = toHttpUrlOrNull() ?: return null
        if (url.host != "hamtruyen.top") return null
        if (url.pathSegments.size != 1) return null
        val slug = url.pathSegments.first()
        if (slug in RESERVED_PATHS || slug.startsWith("_")) return null
        return "/$slug"
    }

    private fun String.toChapterPath(): String? {
        val url = toHttpUrlOrNull() ?: return null
        if (url.host != "hamtruyen.top") return null
        if (url.pathSegments.size != 2) return null
        if (!url.pathSegments[1].startsWith("chuong-")) return null
        return "/" + url.pathSegments.joinToString("/")
    }

    private class SortFilter : Filter.Select<SelectOption>("Sap xep", OPTIONS) {
        val selected: SelectOption get() = values[state]

        companion object {
            val DEFAULT = SelectOption("Moi cap nhat", "top/new")
            private val OPTIONS = arrayOf(
                DEFAULT,
                SelectOption("Xem nhieu", "top/views"),
                SelectOption("Nhieu chapter", "top/chapters"),
            )
        }
    }

    private class SelectOption(val name: String, val path: String) {
        override fun toString(): String = name
    }

    companion object {
        private const val IMAGE_PROXY_HOST = "hamtruyen-api.hamtruyen.top"
        private const val IMAGE_PROXY_PATH = "/api/image/proxy"
        private const val LEGACY_PATH_PREFIX = "/nettruyen/"
        private val IMAGE_CDN_HOSTS = (1..4).map { "cdn$it.zetimage.com" }
        private val RESERVED_PATHS = setOf(
            "",
            "about",
            "contact",
            "page",
            "search",
            "sitemap.xml",
            "sitemap-index.xml",
            "top",
        )
        private val CHAPTER_NUMBER_REGEX = Regex("""(?:chuong|chapter)\s*([0-9]+(?:\.[0-9]+)?)""", RegexOption.IGNORE_CASE)
        private val CHAPTER_COUNT_REGEX = Regex("""\b([0-9]+)\s*chapters?\b""", RegexOption.IGNORE_CASE)
    }
}
