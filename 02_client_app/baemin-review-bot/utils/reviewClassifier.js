function classifyReview({ reviewText, hasPhoto }) {
  const text = (reviewText || '').trim();

  if (!text && !hasPhoto) return '별점만 리뷰';
  if (!text && hasPhoto) return '사진만 리뷰';

  if (text && !hasPhoto) {
    if (text.length <= 8) return '짧은 글 리뷰';
    return '긴 글 리뷰';
  }

  if (text && hasPhoto) {
    if (text.length <= 8) return '사진 + 짧은 글 리뷰';
    return '사진 + 긴 글 리뷰';
  }

  return '알 수 없음';
}

module.exports = {
  classifyReview,
};