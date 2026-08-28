package eu.kanade.tachiyomi.extension.vi.otruyen

import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import keiyoushi.utils.tryParse
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import org.jsoup.Jsoup
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import kotlin.math.ceil

private const val CHAPTER_DATA_SEPARATOR = "|"

@Serializable
class DataDto<T>(
    val data: T,
)

@Serializable
class ListingData(
    val items: List<EntriesData> = emptyList(),
    val params: ParamsListing = ParamsListing(),
) {
    fun hasNextPage(): Boolean = params.pagination.hasNextPage(items)
}

@Serializable
class ParamsListing(
    val pagination: Pagination = Pagination(),
)

@Serializable
class Pagination(
    val totalItems: Int = 0,
    val totalItemsPerPage: Int = 0,
    val currentPage: Int = 1,
) {
    fun hasNextPage(items: List<EntriesData>): Boolean {
        if (totalItemsPerPage <= 0) {
            return items.isNotEmpty()
        }

        val totalPages = ceil(totalItems.toDouble() / totalItemsPerPage).toInt()
        return currentPage < totalPages
    }
}

@Serializable
class EntriesData(
    private val name: String = "",
    private val slug: String = "",
    @SerialName("thumb_url") private val thumbUrl: String? = null,
    private val category: List<Category> = emptyList(),
) {
    fun toSManga(imgUrl: String): SManga = SManga.create().apply {
        url = slug
        title = name
        thumbnail_url = thumbUrl.toThumbnailUrl(imgUrl)
        genre = category.joinToString { it.name }
    }
}

@Serializable
class Category(
    val name: String = "",
)

@Serializable
class EntryData(
    val item: Entry,
)

@Serializable
class Entry(
    private val name: String = "",
    val slug: String = "",
    @SerialName("origin_name") private val originName: List<String> = emptyList(),
    private val content: String = "",
    private val status: String = "",
    @SerialName("thumb_url") private val thumbUrl: String? = null,
    private val author: List<String> = emptyList(),
    private val category: List<Category> = emptyList(),
    val chapters: List<ChapterDto> = emptyList(),
    val updatedAt: String? = null,
) {
    fun toSManga(imgUrl: String): SManga = SManga.create().apply {
        val entry = this@Entry
        val altNames = originName.filter { it.isNotBlank() }
        val descText = Jsoup.parse(content).wholeText()

        author = entry.author.filter { it.isNotBlank() }.joinToString()
        description = buildString {
            if (altNames.isNotEmpty()) {
                append("Tên khác: ${altNames.joinToString()}\n\n")
            }
            append(descText)
        }
        genre = category.joinToString { it.name }
        title = name
        thumbnail_url = thumbUrl.toThumbnailUrl(imgUrl)
        status = when (entry.status) {
            "ongoing" -> SManga.ONGOING
            "completed" -> SManga.COMPLETED
            "coming_soon" -> SManga.ONGOING
            else -> SManga.UNKNOWN
        }
    }
}

@Serializable
class ChapterDto(
    @SerialName("server_name") val serverName: String? = null,
    @SerialName("server_data") val serverData: List<ChapterData> = emptyList(),
)

@Serializable
class ChapterData(
    @SerialName("chapter_name") private val chapterName: String = "",
    @SerialName("chapter_title") private val chapterTitle: String? = null,
    @SerialName("chapter_api_data") private val chapterApiData: String = "",
) {
    fun toSChapter(date: String?, mangaSlug: String): SChapter = SChapter.create().apply {
        val titleText = chapterTitle?.trim()?.takeIf { it.isNotBlank() }
        val readableName = chapterName.ifBlank { chapterApiData.substringAfterLast("/") }

        name = buildString {
            append("Chapter ")
            append(readableName)
            if (titleText != null) {
                append(": ")
                append(titleText)
            }
        }
        date_upload = date?.let { dateFormat.tryParse(it) } ?: 0L
        chapter_number = chapterName.toFloatOrNull() ?: -1f
        url = listOf(chapterApiData, mangaSlug, chapterName).joinToString(CHAPTER_DATA_SEPARATOR)
    }
}

@Serializable
class PageDto(
    @SerialName("domain_cdn") val domainCdn: String = "",
    private val item: PageItem = PageItem(),
) {
    fun toPage(): List<Page> {
        val basePath = "${domainCdn.trimEnd('/')}/${item.chapterPath.trim('/')}/"
        return item.chapterImage.mapIndexed { index, image ->
            val imageFile = image.imageFile
            val imageUrl = if (imageFile.startsWith("http")) {
                imageFile
            } else {
                basePath + imageFile
            }
            Page(index, imageUrl = imageUrl)
        }
    }
}

@Serializable
class PageItem(
    @SerialName("chapter_path") val chapterPath: String = "",
    @SerialName("chapter_image") val chapterImage: List<PageImage> = emptyList(),
)

@Serializable
class PageImage(
    @SerialName("image_file") val imageFile: String = "",
)

@Serializable
class GenresData(
    val items: List<GenreItem> = emptyList(),
)

@Serializable
class GenreItem(
    val slug: String = "",
    val name: String = "",
)

internal fun String.toChapterApiUrl(legacyCdnUrl: String): String {
    val apiUrl = substringBefore(CHAPTER_DATA_SEPARATOR)
    return when {
        apiUrl.startsWith("http") -> apiUrl
        contains(":") -> "$legacyCdnUrl/v1/api/chapter/${substringBefore(":")}"
        else -> apiUrl
    }
}

internal fun String.toChapterWebUrl(baseUrl: String): String {
    val parts = split(CHAPTER_DATA_SEPARATOR)
    val mangaSlug = when {
        parts.size > 1 -> parts[1]
        contains(":") -> substringAfter(":")
        else -> ""
    }
    val chapterName = parts.getOrNull(2).orEmpty()

    return if (mangaSlug.isBlank()) {
        baseUrl
    } else if (chapterName.isBlank()) {
        "$baseUrl/truyen-tranh/$mangaSlug"
    } else {
        "$baseUrl/truyen-tranh/$mangaSlug/chapter-$chapterName"
    }
}

private fun String?.toThumbnailUrl(imgUrl: String): String? {
    val thumb = this?.trim()?.takeIf { it.isNotBlank() } ?: return null
    val imageHost = imgUrl.substringBefore("/uploads/")

    return when {
        thumb.startsWith("http") -> thumb
        thumb.startsWith("/") -> imageHost + thumb
        thumb.startsWith("uploads/") -> "$imageHost/$thumb"
        else -> "$imgUrl/$thumb"
    }
}

private val dateFormat = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply {
    timeZone = TimeZone.getTimeZone("UTC")
}
