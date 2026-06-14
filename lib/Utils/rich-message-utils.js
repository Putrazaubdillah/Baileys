import { getRandomValues, randomUUID, randomBytes } from 'crypto';
import { DONATE_URL, LEXER_REGEX } from '../Defaults/index.js';
import { LANGUAGE_KEYWORDS } from '../WABinary/constants.js';
import { CodeHighlightType, RichSubMessageType } from '../Types/RichType.js';
import { proto } from '../../WAProto/index.js';
import { unixTimestampSeconds, generateMessageIDV2 } from './generics.js';

const NOOP = new Set([]);

/* ─────────────────────────────────────────────────────────────
   LATEX URL GENERATOR
   WhatsApp client membutuhkan URL gambar render untuk setiap
   LaTeX expression. Tanpa URL, pesan tampil kosong.
   Gunakan latex.codecogs.com sebagai fallback gratis~
───────────────────────────────────────────────────────────── */
const buildLatexUrl = (expression) => {
    if (!expression) return null;
    const encoded = encodeURIComponent(expression);
    return `https://latex.codecogs.com/png.image?\dpi{150}\bg{white}${encoded}`;
};

/* ─────────────────────────────────────────────────────────────
   IMAGE URL HELPER
   Konversi objek AIRichResponseImageURL ke snake_case JSON
   agar WA client bisa baca dengan benar~
───────────────────────────────────────────────────────────── */
const toImageUrlJson = (imgUrl) => {
    if (!imgUrl) return null;
    // support both plain string and object
    if (typeof imgUrl === 'string') return { image_preview_url: imgUrl, image_high_res_url: imgUrl, source_url: null };
    return {
        image_preview_url: imgUrl.imagePreviewUrl || imgUrl.image_preview_url || null,
        image_high_res_url: imgUrl.imageHighResUrl || imgUrl.image_high_res_url || null,
        source_url: imgUrl.sourceUrl || imgUrl.source_url || null
    };
};

/* ─────────────────────────────────────────────────────────────
   TOKENIZER
───────────────────────────────────────────────────────────── */

export const tokenizeCode = (code, language = 'javascript') => {
    const keywords = LANGUAGE_KEYWORDS[language] || NOOP;
    const blocks = [];
    LEXER_REGEX.lastIndex = 0;
    let match;
    while ((match = LEXER_REGEX.exec(code)) !== null) {
        if (match[1]) {
            blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: match[1] });
        } else if (match[2]) {
            blocks.push({ highlightType: CodeHighlightType.STRING, codeContent: match[2] });
        } else if (match[3]) {
            blocks.push({
                highlightType: keywords.has(match[3]) ? CodeHighlightType.KEYWORD : CodeHighlightType.METHOD,
                codeContent: match[3],
            });
        } else if (match[4]) {
            blocks.push({
                highlightType: keywords.has(match[4]) ? CodeHighlightType.KEYWORD : CodeHighlightType.DEFAULT,
                codeContent: match[4],
            });
        } else if (match[5]) {
            blocks.push({ highlightType: CodeHighlightType.NUMBER, codeContent: match[5] });
        } else {
            blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: match[6] });
        }
    }
    return blocks;
};

/* ─────────────────────────────────────────────────────────────
   INCOMING DECODER — parse rich message yang diterima
───────────────────────────────────────────────────────────── */

/**
 * Parse sebuah AIRichResponseSubMessage proto menjadi object JS yang mudah dipakai.
 * Return null kalau tipe tidak dikenal.
 */
export const parseRichSubMessage = (submessage) => {
    if (!submessage) return null;
    const type = submessage.messageType;

    switch (type) {
        case RichSubMessageType.TEXT:
            return {
                type: 'text',
                text: submessage.messageText || '',
            };

        case RichSubMessageType.CODE:
            return {
                type: 'code',
                language: submessage.codeMetadata?.codeLanguage || 'plain',
                blocks: (submessage.codeMetadata?.codeBlocks || []).map(b => ({
                    highlight: CodeHighlightType[b.highlightType] ?? 'DEFAULT',
                    content: b.codeContent || '',
                })),
                /** Helper: ambil source code mentah tanpa highlight info */
                get raw() {
                    return this.blocks.map(b => b.content).join('');
                },
            };

        case RichSubMessageType.TABLE:
            return {
                type: 'table',
                title: submessage.tableMetadata?.title || '',
                rows: (submessage.tableMetadata?.rows || []).map(row => ({
                    isHeading: row.isHeading ?? false,
                    items: row.items || [],
                })),
            };

        case RichSubMessageType.GRID_IMAGE:
            return {
                type: 'gridImage',
                gridImageUrl: submessage.gridImageMetadata?.gridImageUrl || null,
                imageUrls: submessage.gridImageMetadata?.imageUrls || [],
            };

        case RichSubMessageType.INLINE_IMAGE:
            return {
                type: 'inlineImage',
                imageUrl: submessage.imageMetadata?.imageUrl || null,
                imageText: submessage.imageMetadata?.imageText || '',
                alignment: submessage.imageMetadata?.alignment ?? 0,
                tapLinkUrl: submessage.imageMetadata?.tapLinkUrl || null,
            };

        case RichSubMessageType.DYNAMIC:
            return {
                type: 'dynamic',
                dynamicType: submessage.dynamicMetadata?.type ?? 0,
                version: submessage.dynamicMetadata?.version ?? 0,
                url: submessage.dynamicMetadata?.url || null,
                loopCount: submessage.dynamicMetadata?.loopCount ?? 0,
            };

        case RichSubMessageType.MAP:
            return {
                type: 'map',
                centerLatitude: submessage.mapMetadata?.centerLatitude ?? 0,
                centerLongitude: submessage.mapMetadata?.centerLongitude ?? 0,
                latitudeDelta: submessage.mapMetadata?.latitudeDelta ?? 0,
                longitudeDelta: submessage.mapMetadata?.longitudeDelta ?? 0,
                showInfoList: submessage.mapMetadata?.showInfoList ?? false,
                annotations: (submessage.mapMetadata?.annotations || []).map(a => ({
                    number: a.annotationNumber ?? 0,
                    latitude: a.latitude ?? 0,
                    longitude: a.longitude ?? 0,
                    title: a.title || '',
                    body: a.body || '',
                })),
            };

        case RichSubMessageType.LATEX:
            return {
                type: 'latex',
                text: submessage.latexMetadata?.text || '',
                expressions: (submessage.latexMetadata?.expressions || []).map(e => ({
                    expression: e.latexExpression || '',
                    url: e.url || null,
                    width: e.width ?? 0,
                    height: e.height ?? 0,
                })),
            };

        case RichSubMessageType.CONTENT_ITEMS:
            return {
                type: 'contentItems',
                contentType: submessage.contentItemsMetadata?.contentType ?? 0,
                items: (submessage.contentItemsMetadata?.itemsMetadata || []).map(item => {
                    if (item.reelItem) {
                        return {
                            kind: 'reel',
                            title: item.reelItem.title || '',
                            profileIconUrl: item.reelItem.profileIconUrl || null,
                            thumbnailUrl: item.reelItem.thumbnailUrl || null,
                            videoUrl: item.reelItem.videoUrl || null,
                        };
                    }
                    return { kind: 'unknown' };
                }),
            };

        default:
            return { type: 'unknown', raw: submessage };
    }
};

/**
 * Parse seluruh AIRichResponseMessage menjadi array parsed submessages.
 * Bisa dipanggil langsung dari handler messages.upsert:
 *
 *   const inner = normalizeMessageContent(msg.message)
 *   const parsed = parseRichMessage(inner?.richResponseMessage)
 */
export const parseRichMessage = (richResponseMessage) => {
    if (!richResponseMessage) return null;

    const submessages = (richResponseMessage.submessages || [])
        .map(parseRichSubMessage)
        .filter(Boolean);

    let unifiedData = null;
    if (richResponseMessage.unifiedResponse?.data) {
        try {
            const buf = richResponseMessage.unifiedResponse.data;
            unifiedData = JSON.parse(Buffer.isBuffer(buf) ? buf.toString('utf-8') : Buffer.from(buf).toString('utf-8'));
        } catch (_) { /* ignore parse error */ }
    }

    return {
        messageType: richResponseMessage.messageType ?? 0,
        submessages,
        unifiedData,
    };
};

/* ─────────────────────────────────────────────────────────────
   OUTGOING BUILDER — unified response JSON per subtype
───────────────────────────────────────────────────────────── */

const buildUnifiedSection = (submessage) => {
    switch (submessage.messageType) {
        case RichSubMessageType.TEXT:
            return {
                view_model: {
                    primitive: {
                        text: submessage.messageText,
                        inline_entities: submessage.inlineEntities || [],
                        __typename: 'GenAIMarkdownTextUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };

        case RichSubMessageType.CODE: {
            const cm = submessage.codeMetadata;
            return {
                view_model: {
                    primitive: {
                        language: cm.codeLanguage,
                        code_blocks: cm.codeBlocks.map(b => ({
                            content: b.codeContent,
                            type: CodeHighlightType[b.highlightType]
                        })),
                        __typename: 'GenAICodeUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }

        case RichSubMessageType.TABLE: {
            const tm = submessage.tableMetadata;
            return {
                view_model: {
                    primitive: {
                        title: tm.title,
                        rows: tm.rows.map(row => ({
                            is_header: row.isHeading,
                            cells: row.items,
                            markdown_cells: row.items.map(item => ({ text: item }))
                        })),
                        __typename: 'GenATableUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }

        case RichSubMessageType.GRID_IMAGE: {
            const gm = submessage.gridImageMetadata;
            return {
                view_model: {
                    primitive: {
                        grid_image_url: toImageUrlJson(gm.gridImageUrl),
                        image_urls: (gm.imageUrls || []).map(toImageUrlJson),
                        __typename: 'GenAIGridImageUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }

        case RichSubMessageType.INLINE_IMAGE: {
            const im = submessage.imageMetadata;
            return {
                view_model: {
                    primitive: {
                        image_url: toImageUrlJson(im.imageUrl),
                        image_text: im.imageText,
                        alignment: im.alignment ?? 0,
                        tap_link_url: im.tapLinkUrl || null,
                        __typename: 'GenAIInlineImageUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }

        case RichSubMessageType.DYNAMIC: {
            const dm = submessage.dynamicMetadata;
            return {
                view_model: {
                    primitive: {
                        type: dm.type ?? 0,
                        version: dm.version ?? 0,
                        url: dm.url,
                        loop_count: dm.loopCount ?? 0,
                        __typename: 'GenAIDynamicUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }

        case RichSubMessageType.MAP: {
            const mm = submessage.mapMetadata;
            return {
                view_model: {
                    primitive: {
                        center_latitude: mm.centerLatitude,
                        center_longitude: mm.centerLongitude,
                        latitude_delta: mm.latitudeDelta,
                        longitude_delta: mm.longitudeDelta,
                        show_info_list: mm.showInfoList ?? false,
                        annotations: (mm.annotations || []).map(a => ({
                            annotation_number: a.annotationNumber,
                            latitude: a.latitude,
                            longitude: a.longitude,
                            title: a.title,
                            body: a.body
                        })),
                        __typename: 'GenAIMapUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }

        case RichSubMessageType.LATEX: {
            const lm = submessage.latexMetadata;
            return {
                view_model: {
                    primitive: {
                        text: lm.text,
                        expressions: (lm.expressions || []).map(e => ({
                            latex_expression: e.latexExpression,
                            url: e.url,
                            width: e.width,
                            height: e.height,
                            font_height: e.fontHeight,
                            image_top_padding: e.imageTopPadding,
                            image_leading_padding: e.imageLeadingPadding,
                            image_bottom_padding: e.imageBottomPadding,
                            image_trailing_padding: e.imageTrailingPadding
                        })),
                        __typename: 'GenAILatexUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }

        case RichSubMessageType.CONTENT_ITEMS: {
            const ci = submessage.contentItemsMetadata;
            return {
                view_model: {
                    primitive: {
                        content_type: ci.contentType ?? 0,
                        items_metadata: (ci.itemsMetadata || []).map(item => {
                            if (item.reelItem) {
                                return {
                                    reel_item: {
                                        title: item.reelItem.title,
                                        profile_icon_url: item.reelItem.profileIconUrl,
                                        thumbnail_url: item.reelItem.thumbnailUrl,
                                        video_url: item.reelItem.videoUrl
                                    }
                                };
                            }
                            return {};
                        }),
                        __typename: 'GenAIContentItemsUXPrimitive'
                    },
                    __typename: 'GenAISingleLayoutViewModel'
                }
            };
        }

        default:
            return submessage;
    }
};

export const toUnified = (submessages) => ({
    response_id: randomUUID(),
    sections: submessages.map(buildUnifiedSection)
});

/* ─────────────────────────────────────────────────────────────
   PREPARE HELPERS — builder per tipe submessage
───────────────────────────────────────────────────────────── */

/** Buat submessage TEXT */
const makeTextSub = (text, inlineEntities) => ({
    messageType: RichSubMessageType.TEXT,
    messageText: text,
    ...(inlineEntities ? { inlineEntities } : {})
});

/** Buat submessage CODE dengan auto-tokenize */
const makeCodeSub = (code, language = 'javascript') => ({
    messageType: RichSubMessageType.CODE,
    codeMetadata: {
        codeLanguage: language,
        codeBlocks: tokenizeCode(code, language)
    }
});

/** Buat submessage TABLE */
const makeTableSub = (rows, title, noHeading) => ({
    messageType: RichSubMessageType.TABLE,
    tableMetadata: {
        title: title || '',
        rows: rows.map((items, i) => ({
            isHeading: !noHeading && i === 0,
            items
        }))
    }
});

/** Normalize input ke format AIRichResponseImageURL */
const normalizeImageUrl = (u) => {
    if (!u) return null;
    if (typeof u === 'string') return { imagePreviewUrl: u, imageHighResUrl: u, sourceUrl: null };
    return {
        imagePreviewUrl: u.imagePreviewUrl || u.image_preview_url || null,
        imageHighResUrl: u.imageHighResUrl || u.image_high_res_url || null,
        sourceUrl: u.sourceUrl || u.source_url || null
    };
};

/** Buat submessage GRID_IMAGE */
const makeGridImageSub = (gridImageUrl, imageUrls = []) => ({
    messageType: RichSubMessageType.GRID_IMAGE,
    gridImageMetadata: {
        gridImageUrl: normalizeImageUrl(gridImageUrl),
        imageUrls: (imageUrls || []).map(normalizeImageUrl)
    }
});

/** Buat submessage INLINE_IMAGE */
const makeInlineImageSub = (imageUrl, imageText = '', alignment = 0, tapLinkUrl = null) => ({
    messageType: RichSubMessageType.INLINE_IMAGE,
    imageMetadata: {
        imageUrl: normalizeImageUrl(imageUrl),
        imageText,
        alignment,
        tapLinkUrl
    }
});

/** Buat submessage DYNAMIC (animated image/GIF) */
const makeDynamicSub = (url, dynamicType = 1, version = 1, loopCount = 0) => ({
    messageType: RichSubMessageType.DYNAMIC,
    dynamicMetadata: { type: dynamicType, version, url, loopCount }
});

/** Buat submessage MAP */
const makeMapSub = (centerLatitude, centerLongitude, options = {}) => ({
    messageType: RichSubMessageType.MAP,
    mapMetadata: {
        centerLatitude,
        centerLongitude,
        latitudeDelta: options.latitudeDelta ?? 0.05,
        longitudeDelta: options.longitudeDelta ?? 0.05,
        showInfoList: options.showInfoList ?? false,
        annotations: (options.annotations || []).map((a, i) => ({
            annotationNumber: a.number ?? i + 1,
            latitude: a.latitude,
            longitude: a.longitude,
            title: a.title || '',
            body: a.body || ''
        }))
    }
});

/** Buat submessage LATEX */
const makeLatexSub = (text, expressions = []) => ({
    messageType: RichSubMessageType.LATEX,
    latexMetadata: {
        text,
        expressions: expressions.map(e => {
            const expr = e.expression || e.latexExpression || '';
            // url WAJIB ada agar WA client bisa render — auto-generate jika tidak disupply
            const url = e.url || buildLatexUrl(expr);
            return {
                latexExpression: expr,
                url,
                width: e.width ?? 120,
                height: e.height ?? 40,
                fontHeight: e.fontHeight ?? 0,
                imageTopPadding: e.imageTopPadding ?? 0,
                imageLeadingPadding: e.imageLeadingPadding ?? 0,
                imageBottomPadding: e.imageBottomPadding ?? 0,
                imageTrailingPadding: e.imageTrailingPadding ?? 0
            };
        })
    }
});

/** Buat submessage CONTENT_ITEMS (carousel reel) */
const makeContentItemsSub = (items, contentType = 0) => ({
    messageType: RichSubMessageType.CONTENT_ITEMS,
    contentItemsMetadata: {
        contentType,
        itemsMetadata: items.map(item => {
            if (item.reelItem || item.kind === 'reel') {
                const r = item.reelItem || item;
                return {
                    reelItem: {
                        title: r.title || '',
                        profileIconUrl: r.profileIconUrl || null,
                        thumbnailUrl: r.thumbnailUrl || null,
                        videoUrl: r.videoUrl || null
                    }
                };
            }
            return {};
        })
    }
});

/** Buat section SOURCE (search result links) — hanya unified, tidak ada submessage proto */
const makeSourceSection = (sources = []) => {
    const list = Array.isArray(sources) ? sources : [sources];
    return {
        view_model: {
            primitive: {
                sources: list.map(s => ({
                    source_url: s.url ?? s.source_url ?? '',
                    source_title: s.title ?? s.source_title ?? '',
                    source_display_name: s.display_name ?? s.displayName ?? s.title ?? '',
                    source_subtitle: s.subtitle ?? s.source_subtitle ?? '',
                    source_type: s.source_type ?? 'THIRD_PARTY',
                    favicon: {
                        url: s.favicon ?? s.faviconCDNURL ?? '',
                        width: 16,
                        height: 16
                    }
                })),
                __typename: 'GenAISearchResultPrimitive'
            },
            __typename: 'GenAISingleLayoutViewModel'
        }
    };
};

/** Buat submessage + unified section untuk IMAGE (grid image style) */
const makeImageSub = (imageUrl) => {
    const urls = Array.isArray(imageUrl) ? imageUrl : [imageUrl];
    const imageUrls = urls.map(u => ({
        imagePreviewUrl: u,
        imageHighResUrl: u,
        sourceUrl: null
    }));
    return {
        sub: {
            messageType: RichSubMessageType.GRID_IMAGE,
            gridImageMetadata: {
                gridImageUrl: normalizeImageUrl(urls[0]),
                imageUrls: imageUrls.map(normalizeImageUrl)
            }
        },
        sections: imageUrls.map(({ imagePreviewUrl }) => ({
            view_model: {
                primitive: {
                    media: { url: imagePreviewUrl, mime_type: 'image/png' },
                    imagine_type: 'IMAGE',
                    status: { status: 'READY' },
                    __typename: 'GenAIImaginePrimitive'
                },
                __typename: 'GenAISingleLayoutViewModel'
            }
        }))
    };
};

/** Buat submessage + unified section untuk VIDEO */
const makeVideoSub = (videoUrl) => {
    const urls = Array.isArray(videoUrl) ? videoUrl : [videoUrl];
    const parsed = urls.map(item => {
        const [url, duration = '0'] = item.split('|');
        return { url, duration: Number(duration) || 0 };
    });
    return {
        sub: {
            messageType: RichSubMessageType.DYNAMIC,
            dynamicMetadata: {
                type: 1,
                version: 1,
                url: parsed[0]?.url || '',
                loopCount: 0
            }
        },
        sections: parsed.map(({ url, duration }) => ({
            view_model: {
                primitive: {
                    media: { url, mime_type: 'video/mp4', duration },
                    imagine_type: 'ANIMATE',
                    status: { status: 'READY' },
                    __typename: 'GenAIImaginePrimitive'
                },
                __typename: 'GenAISingleLayoutViewModel'
            }
        }))
    };
};

/** Buat submessage + unified section untuk REELS (HScroll) */
const makeReelsSub = (reelsItems = []) => {
    const list = Array.isArray(reelsItems) ? reelsItems : [reelsItems];
    return {
        sub: {
            messageType: RichSubMessageType.CONTENT_ITEMS,
            contentItemsMetadata: {
                contentType: 1,
                itemsMetadata: list.map(item => ({
                    reelItem: {
                        title: item.username ?? item.title ?? '',
                        profileIconUrl: item.profileIconUrl ?? item.profile_url ?? null,
                        thumbnailUrl: item.thumbnailUrl ?? item.thumbnail ?? null,
                        videoUrl: item.videoUrl ?? item.url ?? null
                    }
                }))
            }
        },
        section: {
            view_model: {
                primitives: list.map(item => ({
                    reels_url: item.videoUrl ?? item.url ?? '',
                    thumbnail_url: item.thumbnailUrl ?? item.thumbnail ?? '',
                    creator: item.username ?? item.title ?? '',
                    avatar_url: item.profileIconUrl ?? item.profile_url ?? '',
                    reels_title: item.reels_title ?? item.title ?? '',
                    likes_count: item.likes_count ?? item.like ?? 0,
                    shares_count: item.shares_count ?? item.share ?? 0,
                    view_count: item.view_count ?? item.view ?? 0,
                    reel_source: item.reel_source ?? item.source ?? 'IG',
                    is_verified: !!(item.is_verified || item.verified),
                    __typename: 'GenAIReelPrimitive'
                })),
                __typename: 'GenAIHScrollLayoutViewModel'
            }
        }
    };
};

/** Buat unified section untuk PRODUCT (single: Single layout, array: HScroll) */
const makeProductSection = (data) => {
    const items = Array.isArray(data) ? data : [data];
    const primitives = items.map(item => ({
        title: item.title ?? '',
        brand: item.brand ?? '',
        price: item.price ?? '',
        sale_price: item.sale_price ?? item.salePrice ?? '',
        product_url: item.product_url ?? item.url ?? '',
        image: { url: item.image_url ?? item.image ?? '' },
        additional_images: [{ url: item.icon_url ?? item.icon ?? '' }],
        __typename: 'GenAIProductItemCardPrimitive'
    }));
    const isMultiple = Array.isArray(data);
    return {
        sub: {
            messageType: RichSubMessageType.TEXT,
            messageText: ''
        },
        section: isMultiple
            ? {
                view_model: {
                    primitives,
                    __typename: 'GenAIHScrollLayoutViewModel'
                }
            }
            : {
                view_model: {
                    primitive: primitives[0],
                    __typename: 'GenAISingleLayoutViewModel'
                }
            }
    };
};

/** Buat unified section untuk POST (HScroll) */
const makePostSection = (data) => {
    const posts = Array.isArray(data) ? data : [data];
    const primitives = posts.map(p => ({
        title: p.title ?? '',
        subtitle: p.subtitle ?? '',
        username: p.username ?? '',
        profile_picture_url: p.profile_picture_url ?? p.profile_url ?? '',
        is_verified: !!(p.is_verified || p.verified),
        thumbnail_url: p.thumbnail_url ?? p.thumbnail ?? '',
        post_caption: p.post_caption ?? p.caption ?? '',
        likes_count: p.likes_count ?? p.like ?? 0,
        comments_count: p.comments_count ?? p.comment ?? 0,
        shares_count: p.shares_count ?? p.share ?? 0,
        post_url: p.post_url ?? p.url ?? '',
        post_deeplink: p.post_deeplink ?? p.deeplink ?? '',
        source_app: p.source_app ?? p.source ?? 'INSTAGRAM',
        footer_label: p.footer_label ?? p.footer ?? '',
        footer_icon: p.footer_icon ?? p.icon ?? '',
        is_carousel: posts.length > 1,
        orientation: p.orientation ?? 'LANDSCAPE',
        post_type: p.post_type ?? 'VIDEO',
        __typename: 'GenAIPostPrimitive'
    }));
    return {
        sub: {
            messageType: RichSubMessageType.TEXT,
            messageText: ''
        },
        section: {
            view_model: {
                primitives,
                __typename: 'GenAIHScrollLayoutViewModel'
            }
        }
    };
};

/** Buat submessage + unified section untuk TIP (metadata text) */
const makeTipSub = (text) => ({
    sub: {
        messageType: RichSubMessageType.TEXT,
        messageText: text
    },
    section: {
        view_model: {
            primitive: {
                text,
                __typename: 'GenAIMetadataTextPrimitive'
            },
            __typename: 'GenAISingleLayoutViewModel'
        }
    }
});

/** Buat unified section untuk SUGGEST (ActionRow pill buttons) — tidak ada submessage proto */
const makeSuggestSection = (suggestion) => {
    const suggestions = Array.isArray(suggestion) ? suggestion : [suggestion];
    return {
        view_model: {
            primitives: suggestions.map(text => ({
                prompt_text: text,
                prompt_type: 'SUGGESTED_PROMPT',
                __typename: 'GenAIFollowUpSuggestionPillPrimitive'
            })),
            __typename: 'GenAIActionRowLayoutViewModel'
        }
    };
};

/* ─────────────────────────────────────────────────────────────
   MAIN BUILDER — prepareRichResponseMessage
───────────────────────────────────────────────────────────── */

export const prepareRichResponseMessage = (content) => {
    const {
        code, contentText, disclaimerText, footerText, headerText,
        language, links, noHeading, richResponse, table, title,
        // sub-types lama
        gridImage, inlineImage, dynamic: dynamicContent,
        map: mapContent, latex, contentItems,
        // sub-types baru (prefixed 'rich' agar tidak konflik dengan media biasa)
        richImage, richVideo, reels, source, richProduct, richPost, tip, suggest
    } = content;

    let submessages = [];
    // extraSections: section-section unified yang tidak punya proto submessage 1:1
    // (source, product, post, suggest) atau punya struktur multi-section (image, video, reels)
    let extraSections = null;

    /**
     * Helper: push ke submessages dan optionally ke extraSections.
     * Untuk tipe yang punya make*Sub yang mengembalikan { sub, sections[] } atau { sub, section }
     */
    const pushRich = (built) => {
        if (!built) return;
        if (built.sub) submessages.push(built.sub);
        if (!extraSections) extraSections = [];
        if (built.sections) extraSections.push(...built.sections);
        else if (built.section) extraSections.push(built.section);
    };

    /* ── mode array (richResponse) — multi-section campuran ── */
    if (Array.isArray(richResponse)) {
        if (headerText) submessages.push(makeTextSub(headerText));
        richResponse.forEach(sub => {
            if (sub.text != null)         { submessages.push(makeTextSub(sub.text, sub.inlineEntities)); return; }
            if (sub.code != null)         { submessages.push(makeCodeSub(sub.code, sub.language || 'javascript')); return; }
            if (sub.table != null)        { submessages.push(makeTableSub(sub.table, sub.title, sub.noHeading)); return; }
            if (sub.gridImage != null)    { submessages.push(makeGridImageSub(sub.gridImage.gridImageUrl, sub.gridImage.imageUrls)); return; }
            if (sub.inlineImage != null)  { submessages.push(makeInlineImageSub(sub.inlineImage.imageUrl, sub.inlineImage.imageText, sub.inlineImage.alignment, sub.inlineImage.tapLinkUrl)); return; }
            if (sub.dynamic != null)      { submessages.push(makeDynamicSub(sub.dynamic.url, sub.dynamic.type, sub.dynamic.version, sub.dynamic.loopCount)); return; }
            if (sub.map != null)          { submessages.push(makeMapSub(sub.map.centerLatitude, sub.map.centerLongitude, sub.map)); return; }
            if (sub.latex != null)        { submessages.push(makeLatexSub(sub.latex.text, sub.latex.expressions)); return; }
            if (sub.contentItems != null) { submessages.push(makeContentItemsSub(sub.contentItems.items, sub.contentItems.contentType)); return; }
            // tipe baru
            if (sub.richImage != null)    { pushRich(makeImageSub(sub.richImage)); return; }
            if (sub.richVideo != null)    { pushRich(makeVideoSub(sub.richVideo)); return; }
            if (sub.reels != null)        { pushRich(makeReelsSub(sub.reels)); return; }
            if (sub.source != null)       { if (!extraSections) extraSections = []; extraSections.push(makeSourceSection(sub.source)); return; }
            if (sub.richProduct != null)  { pushRich(makeProductSection(sub.richProduct)); return; }
            if (sub.richPost != null)     { pushRich(makePostSection(sub.richPost)); return; }
            if (sub.tip != null)          { pushRich(makeTipSub(sub.tip)); return; }
            if (sub.suggest != null)      { if (!extraSections) extraSections = []; extraSections.push(makeSuggestSection(sub.suggest)); return; }
            submessages.push(sub); // passthrough kalau sudah bentuk proto
        });
        if (footerText) submessages.push(makeTextSub(footerText));

    /* ── mode flat (convenience fields) ── */
    } else {
        if (headerText)    submessages.push(makeTextSub(headerText));

        if (code)          submessages.push(makeCodeSub(code, language || 'javascript'));
        if (table)         submessages.push(makeTableSub(table, title, noHeading));
        if (gridImage)     submessages.push(makeGridImageSub(gridImage.gridImageUrl, gridImage.imageUrls));
        if (inlineImage)   submessages.push(makeInlineImageSub(inlineImage.imageUrl, inlineImage.imageText, inlineImage.alignment, inlineImage.tapLinkUrl));
        if (dynamicContent) submessages.push(makeDynamicSub(dynamicContent.url, dynamicContent.type, dynamicContent.version, dynamicContent.loopCount));
        if (mapContent)    submessages.push(makeMapSub(mapContent.centerLatitude, mapContent.centerLongitude, mapContent));
        if (latex)         submessages.push(makeLatexSub(latex.text, latex.expressions));
        if (contentItems)  submessages.push(makeContentItemsSub(contentItems.items, contentItems.contentType));

        // ── tipe baru ──
        if (richImage)    pushRich(makeImageSub(richImage));
        if (richVideo)    pushRich(makeVideoSub(richVideo));
        if (reels)        pushRich(makeReelsSub(reels));
        if (source)       { if (!extraSections) extraSections = []; extraSections.push(makeSourceSection(source)); }
        if (richProduct)  pushRich(makeProductSection(richProduct));
        if (richPost)     pushRich(makePostSection(richPost));
        if (contentText)   submessages.push(makeTextSub(contentText)); // ← setelah produk/post, tampil di bawah card
        if (tip)          pushRich(makeTipSub(tip));
        if (suggest)      { if (!extraSections) extraSections = []; extraSections.push(makeSuggestSection(suggest)); }

        /* links — bisa dikombinasi dengan tipe lain di atas */
        if (links && Array.isArray(links)) {
            links.forEach((linkField, index) => {
                const prefix = 'SS_' + index;
                const url = linkField.url || DONATE_URL;
                const sources = (linkField.sources || []).map(s => ({
                    source_type: 'THIRD_PARTY',
                    source_display_name: s.displayName || 'Source',
                    source_subtitle: s.subtitle || '',
                    source_url: s.url || url
                }));
                submessages.push(makeTextSub(
                    linkField.text + ` {{${prefix}}}¹{{/${prefix}}} `,
                    [{
                        key: prefix,
                        metadata: {
                            reference_id: index + 1,
                            reference_url: url,
                            reference_title: linkField.title || url,
                            reference_display_name: linkField.displayName || url,
                            sources,
                            __typename: 'GenAISearchCitationItem'
                        }
                    }]
                ));
            });
        }

        if (footerText) submessages.push(makeTextSub(footerText));
    }

    /* build unifiedResponse JSON — gabungkan sections dari submessages + extraSections */
    // Pisahkan footerSubs (teks setelah media) agar selalu muncul SETELAH extraSections (video/image)
    const footerSubMessages = footerText ? [makeTextSub(footerText)] : [];
    // Hapus footerText dari submessages jika sudah ada (sudah di-push sebelumnya)
    const mainSubmessages = footerText
        ? submessages.filter(s => !(s.messageType === RichSubMessageType.TEXT && s.messageText === footerText))
        : submessages;
    const baseUnified = toUnified(mainSubmessages);
    const footerSections = footerSubMessages.map(buildUnifiedSection);
    const unified = extraSections && extraSections.length > 0
        ? { ...baseUnified, sections: [...baseUnified.sections, ...extraSections, ...footerSections] }
        : { ...baseUnified, sections: [...baseUnified.sections, ...footerSections] };

    const richResponseMessage = proto.AIRichResponseMessage.create({
        submessages,
        messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        unifiedResponse: {
            data: Buffer.from(JSON.stringify(unified), 'utf-8')
        },
        contextInfo: {
            isForwarded: true,
            forwardingScore: 1,
            forwardOrigin: 4
        }
    });

    const message = wrapToBotForwardedMessage(richResponseMessage);
    const botMetadata = message.messageContextInfo.botMetadata;

    if (disclaimerText) {
        botMetadata.messageDisclaimerText = disclaimerText;
    }
    botMetadata.botResponseId = unified.response_id;

    return message;
};

/* ─────────────────────────────────────────────────────────────
   BOT WRAPPER HELPERS
───────────────────────────────────────────────────────────── */

export const botMetadataSignature = () => {
    const signature = new Uint8Array(64);
    getRandomValues(signature);
    return signature;
};

export const botMetadataCertificate = (length = 685) => {
    const certificate = new Uint8Array(length);
    certificate[0] = 48;
    certificate[1] = 130;
    getRandomValues(certificate.subarray(2));
    return certificate;
};

export const wrapToBotForwardedMessage = (richResponseMessage) => ({
    messageContextInfo: {
        botMetadata: {
            verificationMetadata: {
                proofs: [
                    {
                        certificateChain: [
                            botMetadataCertificate(),
                            botMetadataCertificate(892)
                        ],
                        version: 1,
                        useCase: 1,
                        signature: botMetadataSignature()
                    }
                ]
            }
        }
    },
    botForwardedMessage: {
        message: { richResponseMessage }
    }
});

/* ─────────────────────────────────────────────────────────────
   STANDALONE GENERATORS (kompatibel dengan baileys upstream)
   Semua fungsi di bawah ini di-port dari baileys-main/src/Utils/rich-messages.js
   agar API 100% kompatibel dengan baileys — termasuk sendTable, sendLatex, dll.
───────────────────────────────────────────────────────────── */

/* helper: bangun contextInfo dari quoted */
const buildRichContextInfo = (quoted) => {
    const ctxInfo = {
        isForwarded: true,
        forwardingScore: 1,
        forwardOrigin: 4,
    };
    if (quoted?.key) {
        ctxInfo.stanzaId = quoted.key.id;
        ctxInfo.participant = quoted.key.participant || quoted.sender || quoted.key.remoteJid;
        ctxInfo.quotedMessage = quoted.message;
    }
    return ctxInfo;
};

/* helper: wrap submessages + contextInfo ke botForwardedMessage (format lama/V1) */
const buildBotForwardedMessage = (submessages, contextInfo, unifiedResponse) => {
    const richResponse = { messageType: 1, submessages, contextInfo };
    if (unifiedResponse) richResponse.unifiedResponse = unifiedResponse;
    return { botForwardedMessage: { message: { richResponseMessage: richResponse } } };
};

/* helper: wrap proto AIRichResponseMessage ke botForwardedMessage dengan messageContextInfo */
const _wrapProtoToResult = (submessages, quoted) => {
    const unified = toUnified(submessages);
    const richResponseMessage = proto.AIRichResponseMessage.create({
        submessages,
        messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        unifiedResponse: { data: Buffer.from(JSON.stringify(unified), 'utf-8') },
        contextInfo: buildRichContextInfo(quoted),
    });
    return { message: wrapToBotForwardedMessage(richResponseMessage), messageId: generateMessageIDV2() };
};

// ── Table ──────────────────────────────────────────────────

export const generateTableContent = (title, headers, rows, quoted, options = {}) => {
    const { footer, headerText } = options;
    const tableRows = [{ items: headers, isHeading: true }, ...rows.map(row => ({ items: row.map(String) }))];
    const subs = [];
    if (headerText) subs.push({ messageType: RichSubMessageType.TEXT, messageText: headerText });
    subs.push({ messageType: RichSubMessageType.TABLE, tableMetadata: { title, rows: tableRows } });
    if (footer) subs.push({ messageType: RichSubMessageType.TEXT, messageText: footer });
    return _wrapProtoToResult(subs, quoted);
};

export const generateListContent = (title, items, quoted, options = {}) => {
    const { footer, headerText } = options;
    const tableRows = items.map(item => ({ items: Array.isArray(item) ? item.map(String) : [String(item)] }));
    const subs = [];
    if (headerText) subs.push({ messageType: RichSubMessageType.TEXT, messageText: headerText });
    subs.push({ messageType: RichSubMessageType.TABLE, tableMetadata: { title, rows: tableRows } });
    if (footer) subs.push({ messageType: RichSubMessageType.TEXT, messageText: footer });
    return _wrapProtoToResult(subs, quoted);
};

export const toTableMetadataV2 = (arr) => {
    if (!Array.isArray(arr) || arr.length === 0) throw new Error('Input must be a non-empty array');
    const [title, headerStr, ...rest] = arr;
    const splitCols = (str) => typeof str !== 'string' ? [] : str.includes('|') ? str.split('|').map(s => s.trim()) : str.split(',').map(s => s.trim());
    const splitRows = (str) => typeof str !== 'string' ? [] : str.split(';;').map(row => splitCols(row));
    const header = splitCols(headerStr);
    const parsedRows = rest.flatMap(splitRows);
    const maxLen = Math.max(header.length, ...parsedRows.map(r => r.length));
    const unified_rows = [
        { is_header: true, cells: [...header, ...Array(maxLen - header.length).fill('')] },
        ...parsedRows.map(cells => ({ is_header: false, cells: [...cells, ...Array(maxLen - cells.length).fill('')] }))
    ];
    const rows = unified_rows.map(r => ({ items: r.cells, ...(r.is_header ? { isHeading: true } : {}) }));
    return { title, rows, unified_rows };
};

export const generateTableContentV2 = (table, quoted, options = {}) => {
    const { title, footer, headerText, text } = options;
    const { unified_rows } = toTableMetadataV2(table);
    const subs = [];
    const sections = [];
    if (headerText || title) sections.push({ view_model: { primitive: { text: headerText || title, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    if (text) sections.push({ view_model: { primitive: { text, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    sections.push({ view_model: { primitive: { rows: unified_rows, __typename: 'GenATableUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    if (footer) sections.push({ view_model: { primitive: { text: footer, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    // using randomUUID and randomBytes from top-level import
    const base64Data = Buffer.from(JSON.stringify({ response_id: randomUUID(), sections })).toString('base64');
    const ctxInfo = buildRichContextInfo(quoted);
    ctxInfo.forwardingScore = 2;
    ctxInfo.botMessageSharingInfo = { botEntryPointOrigin: 1, forwardScore: 2 };
    const content = {
        messageContextInfo: { threadId: [], deviceListMetadata: { senderKeyIndexes: [], recipientKeyIndexes: [], recipientKeyHash: '', recipientTimestamp: Math.floor(Date.now() / 1000) }, deviceListMetadataVersion: 2, messageSecret: randomBytes(32) },
        botForwardedMessage: { message: { richResponseMessage: { submessages: subs, messageType: 1, unifiedResponse: { data: base64Data }, contextInfo: ctxInfo } } }
    };
    return { message: content, messageId: generateMessageIDV2() };
};

// ── Code Block ────────────────────────────────────────────

export const generateCodeBlockContent = (code, quoted, options = {}) => {
    const { title, footer, language = 'javascript' } = options;
    const subs = [];
    if (title) subs.push({ messageType: RichSubMessageType.TEXT, messageText: title });
    subs.push({ messageType: RichSubMessageType.CODE, codeMetadata: { codeLanguage: language, codeBlocks: tokenizeCode(code, language) } });
    if (footer) subs.push({ messageType: RichSubMessageType.TEXT, messageText: footer });
    return _wrapProtoToResult(subs, quoted);
};

export const generateCodeBlockContentV2 = (code, quoted, options = {}) => {
    const { title, footer, language = 'javascript', text } = options;
    const { unified_codeBlock } = tokenizeCodeV2(code, language);
    const sections = [];
    if (text) sections.push({ view_model: { primitive: { text, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    sections.push({ view_model: { primitive: { language, code_blocks: unified_codeBlock, __typename: 'GenAICodeUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    if (footer) sections.push({ view_model: { primitive: { text: footer, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    // using randomUUID and randomBytes from top-level import
    const base64Data = Buffer.from(JSON.stringify({ response_id: randomUUID(), sections })).toString('base64');
    const ctxInfo = buildRichContextInfo(quoted);
    ctxInfo.forwardingScore = 2;
    ctxInfo.mentionedJid = [];
    ctxInfo.groupMentions = [];
    ctxInfo.statusAttributions = [];
    ctxInfo.botMessageSharingInfo = { botEntryPointOrigin: 1, forwardScore: 2 };
    const content = {
        messageContextInfo: { threadId: [], deviceListMetadata: { senderKeyIndexes: [], recipientKeyIndexes: [], recipientKeyHash: '', recipientTimestamp: Math.floor(Date.now() / 1000) }, deviceListMetadataVersion: 2, messageSecret: randomBytes(32) },
        botForwardedMessage: { message: { richResponseMessage: { submessages: [], messageType: 1, unifiedResponse: { data: base64Data }, contextInfo: ctxInfo } } }
    };
    return { message: content, messageId: generateMessageIDV2() };
};

// ── Rich Message (generic) ────────────────────────────────

export const generateRichMessageContent = (submessages, quoted) => {
    return _wrapProtoToResult(submessages, quoted);
};

export const generateUnifiedResponseContent = (quoted, captured) => {
    const richResponseMessage = proto.AIRichResponseMessage.create({
        submessages: captured.submessages,
        messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        unifiedResponse: captured.unifiedResponse,
        contextInfo: buildRichContextInfo(quoted),
    });
    return { message: wrapToBotForwardedMessage(richResponseMessage), messageId: generateMessageIDV2() };
};

export const captureUnifiedResponse = (msg) => {
    const botFwd = msg?.botForwardedMessage?.message;
    if (!botFwd) return null;
    const rich = botFwd.richResponseMessage;
    if (!rich?.unifiedResponse?.data) return null;
    return { unifiedResponse: { data: rich.unifiedResponse.data }, submessages: rich.submessages || [], contextInfo: rich.contextInfo || {} };
};

// ── Link ──────────────────────────────────────────────────

export const generateLinkContent = (text, links, quoted, options = {}) => {
    const { footer, forwardingScore = 3, citations = [], proofs = [] } = options;
    const subs = [];
    const fullText = footer ? `${text}${footer}` : text;
    subs.push({ messageType: RichSubMessageType.TEXT, messageText: fullText });
    const sections = [];
    const inlineEntities = links.map((link, i) => {
        const url = typeof link === 'string' ? link : link.url;
        const displayName = typeof link === 'object' && link.displayName ? link.displayName : citations[i]?.sourceTitle || `Link ${i + 1}`;
        return { key: `IE_${i}`, metadata: { display_name: displayName, is_trusted: false, url, __typename: 'GenAIInlineLinkItem' } };
    });
    sections.push({ view_model: { primitive: { text, inline_entities: inlineEntities, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    if (footer) sections.push({ view_model: { primitive: { text: footer, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    // using randomUUID and randomBytes from top-level import
    const base64Data = Buffer.from(JSON.stringify({ response_id: randomUUID(), sections })).toString('base64');
    const ctxInfo = buildRichContextInfo(quoted);
    ctxInfo.forwardingScore = forwardingScore;
    ctxInfo.botMessageSharingInfo = { forwardScore: forwardingScore };
    const messageContextInfo = { messageSecret: randomBytes(32) };
    if (citations.length > 0 || proofs.length > 0) {
        const botMetadata = {};
        if (citations.length > 0) botMetadata.richResponseSourcesMetadata = { sources: citations.map((c, i) => ({ provider: 1, thumbnailCdnUrl: '', sourceProviderUrl: typeof links[i] === 'string' ? links[i] : links[i]?.url || '', sourceQuery: c.sourceQuery || '', faviconCdnUrl: c.faviconCdnUrl || '', citationNumber: c.citationNumber ?? i + 1, sourceTitle: c.sourceTitle || '' })) };
        if (proofs.length > 0) botMetadata.verificationMetadata = { proofs: proofs.map(p => ({ version: p.version || 1, useCase: p.useCase || 1, signature: p.signature || '', certificateChain: p.certificateChain || [] })) };
        messageContextInfo.botMetadata = botMetadata;
    }
    const content = { messageContextInfo, botForwardedMessage: { message: { richResponseMessage: { messageType: 1, submessages: subs, unifiedResponse: { data: base64Data }, contextInfo: ctxInfo } } } };
    return { message: content, messageId: generateMessageIDV2() };
};

export const generateLinkContentV2 = (text, links, quoted, options = {}) => {
    const { footer, searchEngine = 'MAME' } = options;
    const subs = [];
    const fullText = footer ? `${text}${footer}` : text;
    subs.push({ messageType: RichSubMessageType.TEXT, messageText: fullText });
    const sections = [];
    const inlineEntities = links.map((link, i) => {
        const url = typeof link === 'string' ? link : link.url;
        const displayName = typeof link === 'object' && link.displayName ? link.displayName : `Link ${i + 1}`;
        const sourceDisplayName = typeof link === 'object' && link.sourceDisplayName ? link.sourceDisplayName : `Source ${i + 1}`;
        const sourceSubtitle = typeof link === 'object' && link.sourceSubtitle ? link.sourceSubtitle : '';
        return { key: `IE_${i}`, metadata: { reference_id: i + 1, reference_url: url, reference_title: displayName, reference_display_name: displayName, sources: [{ source_type: 'THIRD_PARTY', source_display_name: sourceDisplayName, source_subtitle: sourceSubtitle, source_url: url }], __typename: 'GenAISearchCitationItem' } };
    });
    sections.push({ view_model: { primitive: { text, inline_entities: inlineEntities, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    const searchSources = links.map((link, i) => {
        const url = typeof link === 'string' ? link : link.url;
        const sourceDisplayName = typeof link === 'object' && link.sourceDisplayName ? link.sourceDisplayName : `Source ${i + 1}`;
        const sourceSubtitle = typeof link === 'object' && link.sourceSubtitle ? link.sourceSubtitle : '';
        return { source_type: 'THIRD_PARTY', source_display_name: sourceDisplayName, source_subtitle: sourceSubtitle, source_url: url };
    });
    sections.push({ view_model: { primitive: { sources: searchSources, search_engine: searchEngine, __typename: 'GenAISearchResultPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    if (footer) sections.push({ view_model: { primitive: { text: footer, __typename: 'GenAIMarkdownTextUXPrimitive' }, __typename: 'GenAISingleLayoutViewModel' } });
    // using randomUUID and randomBytes from top-level import
    const base64Data = Buffer.from(JSON.stringify({ response_id: randomUUID(), sections })).toString('base64');
    const ctxInfo = { isForwarded: true, forwardOrigin: 4 };
    if (quoted?.key) { ctxInfo.participant = quoted.key.participant || quoted.sender || quoted.key.remoteJid; ctxInfo.quotedMessage = quoted.message; }
    const content = { messageContextInfo: { threadId: [], messageSecret: randomBytes(32) }, botForwardedMessage: { message: { richResponseMessage: { messageType: 1, submessages: subs, unifiedResponse: { data: base64Data }, contextInfo: ctxInfo } } } };
    return { message: content, messageId: generateMessageIDV2() };
};

// ── LaTeX (3 varian, port dari baileys) ──────────────────

/**
 * generateLatexContent — kirim LaTeX dengan URL gambar yang sudah ada (pre-rendered).
 * Jika `expr.url` tidak diisi, otomatis di-generate via buildLatexUrl (codecogs).
 *
 * @param {object} quoted   - pesan yang di-quote (boleh null)
 * @param {object} options  - { text, expressions, headerText, footer }
 *   expressions: Array<{ latexExpression, url?, width?, height?,
 *                         fontHeight?, imageTopPadding?, imageLeadingPadding?,
 *                         imageBottomPadding?, imageTrailingPadding? }>
 */
export const generateLatexContent = (quoted, options) => {
    const { text, expressions, headerText, footer } = options;
    const subs = [];
    if (headerText) subs.push({ messageType: RichSubMessageType.TEXT, messageText: headerText });
    const latexExpressions = expressions.map((expr) => {
        const entry = {
            latexExpression: expr.latexExpression,
            url: expr.url || buildLatexUrl(expr.latexExpression),
            width: expr.width ?? 120,
            height: expr.height ?? 40,
        };
        if (expr.fontHeight !== undefined) entry.fontHeight = expr.fontHeight;
        if (expr.imageTopPadding !== undefined) entry.imageTopPadding = expr.imageTopPadding;
        if (expr.imageLeadingPadding !== undefined) entry.imageLeadingPadding = expr.imageLeadingPadding;
        if (expr.imageBottomPadding !== undefined) entry.imageBottomPadding = expr.imageBottomPadding;
        if (expr.imageTrailingPadding !== undefined) entry.imageTrailingPadding = expr.imageTrailingPadding;
        return entry;
    });
    subs.push({ messageType: RichSubMessageType.LATEX, latexMetadata: { text: text || '', expressions: latexExpressions } });
    if (footer) subs.push({ messageType: RichSubMessageType.TEXT, messageText: footer });
    return _wrapProtoToResult(subs, quoted);
};

/**
 * generateLatexImageContent — render LaTeX ke PNG via renderLatexToPng,
 * upload via uploadFn, kirim sebagai LaTeX message dengan URL hasil upload.
 *
 * @param {object}   quoted           - pesan yang di-quote (boleh null)
 * @param {object}   options          - { text, expressions, headerText, footer }
 * @param {Function} uploadFn         - async (buffer, type) => { url, directPath }
 * @param {Function} renderLatexToPng - async (latexExpression) => { buffer, width, height }
 */
export const generateLatexImageContent = async (quoted, options, uploadFn, renderLatexToPng) => {
    const { text, expressions, headerText, footer } = options;
    const subs = [];
    if (headerText) subs.push({ messageType: RichSubMessageType.TEXT, messageText: headerText });
    const latexExpressions = await Promise.all(
        expressions.map(async (expr) => {
            const { buffer, width, height } = await renderLatexToPng(expr.latexExpression);
            const uploadResult = await uploadFn(buffer, 'image');
            const imageUrl = uploadResult.url || uploadResult.directPath;
            return { latexExpression: expr.latexExpression, url: imageUrl, width, height };
        }),
    );
    subs.push({ messageType: RichSubMessageType.LATEX, latexMetadata: { text: text || '', expressions: latexExpressions } });
    if (footer) subs.push({ messageType: RichSubMessageType.TEXT, messageText: footer });
    return _wrapProtoToResult(subs, quoted);
};

/**
 * generateLatexInlineImageContent — render LaTeX ke PNG, upload, kirim sebagai
 * deretan INLINE_IMAGE (satu per expression). Fallback untuk klien tanpa LaTeX native.
 *
 * @param {object}   quoted           - pesan yang di-quote (boleh null)
 * @param {object}   options          - { text, expressions, headerText, footer }
 * @param {Function} uploadFn         - async (buffer, type) => { url, directPath }
 * @param {Function} renderLatexToPng - async (latexExpression) => { buffer, width, height }
 */
export const generateLatexInlineImageContent = async (quoted, options, uploadFn, renderLatexToPng) => {
    const { text, expressions, headerText, footer } = options;
    const subs = [];
    if (headerText) subs.push({ messageType: RichSubMessageType.TEXT, messageText: headerText });
    if (text) subs.push({ messageType: RichSubMessageType.TEXT, messageText: text });
    for (const expr of expressions) {
        const { buffer, width, height } = await renderLatexToPng(expr.latexExpression);
        const uploadResult = await uploadFn(buffer, 'image');
        const imageUrl = uploadResult.url || uploadResult.directPath;
        subs.push({
            messageType: RichSubMessageType.INLINE_IMAGE,
            imageMetadata: {
                imageUrl: { imagePreviewUrl: imageUrl, imageHighResUrl: imageUrl },
                imageText: expr.latexExpression,
                alignment: 2,
            },
        });
    }
    if (footer) subs.push({ messageType: RichSubMessageType.TEXT, messageText: footer });
    return _wrapProtoToResult(subs, quoted);
};

// ── tokenizeCodeV2 (dipakai oleh generateCodeBlockContentV2) ─

export const tokenizeCodeV2 = (code, language = 'javascript') => {
    const keywords = LANGUAGE_KEYWORDS[language] || LANGUAGE_KEYWORDS['javascript'] || new Set();
    const tokens = [];
    let i = 0;
    const n = code.length;
    const push = (codeContent, highlightType) => {
        if (!codeContent) return;
        const last = tokens[tokens.length - 1];
        if (last && last.highlightType === highlightType) last.codeContent += codeContent;
        else tokens.push({ codeContent, highlightType });
    };
    const isWordStart = (c) => /[a-zA-Z_$]/.test(c);
    const isWord = (c) => /[a-zA-Z0-9_$]/.test(c);
    const isNum = (c) => /[0-9]/.test(c);
    const HIGHLIGHT_TYPE_MAP = { 0: 'DEFAULT', 1: 'KEYWORD', 2: 'METHOD', 3: 'STR', 4: 'NUMBER', 5: 'COMMENT' };
    const isPyBash = ['python','py','bash','sh','shell'].includes(language);
    while (i < n) {
        const c = code[i];
        if (/\s/.test(c)) {
            let s = i; while (i < n && /\s/.test(code[i])) i++;
            push(code.slice(s, i), 0); continue;
        }
        if (c === '/' && code[i + 1] === '/') {
            let s = i; i += 2; while (i < n && code[i] !== '\n') i++;
            push(code.slice(s, i), 5); continue;
        }
        if (c === '/' && code[i + 1] === '*') {
            let s = i; i += 2;
            while (i < n - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
            i += 2; push(code.slice(s, i), 5); continue;
        }
        if (c === '#' && isPyBash) {
            let s = i; i++; while (i < n && code[i] !== '\n') i++;
            push(code.slice(s, i), 5); continue;
        }
        if (c === '"' || c === "'" || c === '`') {
            let s = i; const q = c; i++;
            while (i < n) { if (code[i] === '\\' && i + 1 < n) i += 2; else if (code[i] === q) { i++; break; } else i++; }
            push(code.slice(s, i), 3); continue;
        }
        if (isNum(c)) {
            let s = i; while (i < n && /[0-9.xXa-fA-FeEbBoO_]/.test(code[i])) i++;
            push(code.slice(s, i), 4); continue;
        }
        if (isWordStart(c)) {
            let s = i; while (i < n && isWord(code[i])) i++;
            const word = code.slice(s, i);
            let type = 0;
            if (keywords.has(word)) type = 1;
            else { let j = i; while (j < n && /\s/.test(code[j])) j++; if (code[j] === '(') type = 2; }
            push(word, type); continue;
        }
        push(c, 0); i++;
    }
    return {
        codeBlock: tokens,
        unified_codeBlock: tokens.map(t => ({ content: t.codeContent, type: HIGHLIGHT_TYPE_MAP[t.highlightType] || 'DEFAULT' }))
    };
};

/* Re-export LANGUAGE_KEYWORDS dari WABinary/constants.js agar kompatibel dengan baileys export */
export { LANGUAGE_KEYWORDS } from '../WABinary/constants.js';

//# sourceMappingURL=rich-message-utils.js.map
