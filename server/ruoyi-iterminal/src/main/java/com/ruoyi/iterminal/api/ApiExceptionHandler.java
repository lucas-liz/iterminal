package com.ruoyi.iterminal.api;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import com.ruoyi.common.exception.ServiceException;

/**
 * 客户端接口的异常处理：只作用于 controller.api 包，优先于若依的全局异常处理（那个总是返回 HTTP 200）。
 */
@Order(Ordered.HIGHEST_PRECEDENCE)
@RestControllerAdvice(basePackages = "com.ruoyi.iterminal.controller.api")
public class ApiExceptionHandler
{
    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiResult<Void>> api(ApiException e)
    {
        return ResponseEntity.status(e.getStatus()).body(ApiResult.error(e.getStatus().value(), e.getMessage()));
    }

    /** 若依的业务异常（例如账号已停用、密码错误次数过多） */
    @ExceptionHandler(ServiceException.class)
    public ResponseEntity<ApiResult<Void>> service(ServiceException e)
    {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(ApiResult.error(400, e.getMessage()));
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<ApiResult<Void>> denied(AccessDeniedException e)
    {
        return ResponseEntity.status(HttpStatus.FORBIDDEN).body(ApiResult.error(403, "没有权限"));
    }

    @ExceptionHandler({ HttpMessageNotReadableException.class, MissingServletRequestParameterException.class, IllegalArgumentException.class })
    public ResponseEntity<ApiResult<Void>> bad(Exception e)
    {
        return ResponseEntity.status(HttpStatus.BAD_REQUEST).body(ApiResult.error(400, "请求格式不正确：" + e.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiResult<Void>> other(Exception e)
    {
        log.error("客户端接口异常", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(ApiResult.error(500, "服务端出错，请稍后重试"));
    }
}
